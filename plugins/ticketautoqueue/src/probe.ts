/*
 * TicketAutoQueue for Kettu
 * Copyright (c) 2026 river and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * Ported from the Vencord plugin of the same name.
 */

// Names the dispatches this build actually fires, instead of guessing them.
//
// Two things have been guessed at and got wrong: which event means the gateway
// connected (seven candidates subscribed, none arrived) and whether interaction
// outcomes are reported at all. Both are answerable by watching the dispatcher
// rather than by proposing another name.
//
// This is opt-in and bounded. The interceptor is installed only when /taq events
// is first run, does nothing at all while not capturing, and stops on its own.
// Nothing in the plugin's normal operation depends on it.

import { logger } from "@vendetta";
import { FluxDispatcher } from "@vendetta/metro/common";

import { settings } from "./settings";
import { describeDuration } from "./stats";

// Only the families with an open question against them. Capturing every dispatch
// would bury those in the hundreds of routine ones a client fires per minute.
const INTERESTING = /CONNECT|READY|RESUME|SESSION|GATEWAY|SOCKET|INTERACTION/i;

// Voice and media telemetry matches the filter on "CONNECTION" and fires roughly
// ten times a minute regardless of anything this plugin cares about. Two capture
// runs so far have been mostly this.
const NOISE = /^MEDIA_ENGINE|^VOICE_|^AUDIO_|_STATS$/i;

// A cap, so a pathological run cannot grow this without bound.
const MAX_TYPES = 100;

// The window nobody asked for a length. Long enough to span a ticket, short
// enough that forgetting about it costs nothing.
export const PROBE_DEFAULT_MS = 1800000;

// The ceiling on a requested window. The running cost is one regex per dispatch,
// so this is not about load - it is so a typo cannot arm a capture that outlives
// any reason for having started it.
export const PROBE_MAX_MS = 43200000;

const seen = new Map<string, number>();

let installed = false;
let capturing = false;
let startedAt = 0;
let stopsAt = 0;
let stopTimer: ReturnType<typeof setTimeout> | null = null;
// True when this capture carried over from before a restart, so the report can
// say the counts below it are younger than the window.
let resumed = false;

/**
 * Must never throw and must never return true: a truthy return from a Flux
 * interceptor blocks the action, which would break the client rather than
 * observe it.
 */
function intercept(action: any): boolean {
    try {
        if (!capturing) return false;

        const type = action?.type;
        if (typeof type !== "string") return false;
        if (!INTERESTING.test(type) || NOISE.test(type)) return false;

        const count = seen.get(type);
        if (count !== undefined) seen.set(type, count + 1);
        else if (seen.size < MAX_TYPES) seen.set(type, 1);
    } catch { /* observing must never affect dispatch */ }

    return false;
}

export function isCapturing(): boolean {
    return capturing;
}

/** Sets, or moves, the deadline this capture stops at. */
function armUntil(durationMs: number): void {
    stopsAt = Date.now() + durationMs;
    // Persisted so the window survives Discord restarting - see resumeProbe.
    settings.probeUntil = stopsAt;

    if (stopTimer !== null) clearTimeout(stopTimer);
    stopTimer = setTimeout(stopProbe, durationMs);
}

/**
 * Begins capturing. Returns false when the dispatcher offers no way to observe,
 * so the caller can say so rather than promise a report that will never fill in.
 */
export function startProbe(durationMs: number): boolean {
    if (!installed) {
        const dispatcher = FluxDispatcher as any;
        if (typeof dispatcher?.addInterceptor !== "function") return false;

        try {
            dispatcher.addInterceptor(intercept);
        } catch (err) {
            logger.error("Could not install the dispatch probe:", err);
            return false;
        }
        // Left in place for the session, gated by the flag. Removing it would mean
        // rewriting the dispatcher's interceptor list, which is a far worse thing
        // to get wrong than leaving one predicate that returns immediately.
        installed = true;
    }

    seen.clear();
    resumed = false;
    startedAt = Date.now();
    capturing = true;
    armUntil(durationMs);
    return true;
}

/**
 * Moves a running capture's deadline without discarding what it has counted.
 *
 * Restarting it instead would throw away the hours already watched, which is the
 * opposite of what someone extending a window that has not caught a ticket yet
 * is asking for. Returns false when nothing is running.
 */
export function extendProbe(durationMs: number): boolean {
    if (!capturing) return false;
    armUntil(durationMs);
    return true;
}

/** Ends the capture for good: the window elapsed, or it was stopped by hand. */
export function stopProbe(): void {
    capturing = false;
    stopsAt = 0;
    settings.probeUntil = 0;
    if (stopTimer !== null) clearTimeout(stopTimer);
    stopTimer = null;
}

/**
 * Unload: stop counting, but leave the deadline alone.
 *
 * A plugin reload runs this, and an hours-long window that a reload silently
 * cancelled would be worse than useless - it would read as "still watching"
 * right up until the report came back empty.
 */
export function suspendProbe(): void {
    capturing = false;
    startedAt = 0;
    stopsAt = 0;
    resumed = false;
    seen.clear();
    if (stopTimer !== null) clearTimeout(stopTimer);
    stopTimer = null;
}

/**
 * Load: pick a capture back up if its window has not run out.
 *
 * The events worth catching arrive with a ticket, whenever a client happens to
 * open one, so a useful window is measured in hours - and mobile Discord is
 * restarted often enough that most windows that long will be interrupted. The
 * deadline is persisted; the counts are not, since they only ever lived in
 * memory, so a resumed report says what it is counting from.
 */
export function resumeProbe(): void {
    suspendProbe();

    const until = Number(settings.probeUntil);
    if (!Number.isFinite(until) || until <= Date.now()) {
        settings.probeUntil = 0;
        return;
    }

    if (!startProbe(Math.min(until - Date.now(), PROBE_MAX_MS))) {
        settings.probeUntil = 0;
        return;
    }
    // startProbe cleared this; the window is older than the process it now runs in.
    resumed = true;
}

/** How much of the window is left, or 0 when nothing is being captured. */
export function probeRemainingMs(): number {
    if (!capturing || stopsAt === 0) return 0;
    return Math.max(0, stopsAt - Date.now());
}

function remainingText(): string {
    if (!capturing || stopsAt === 0) return "";
    return ` Still watching for another ${describeDuration(probeRemainingMs())} — run this again any time for an updated list.`;
}

export function probeReport(): string {
    // Clamped so a report pulled the instant a capture starts reads as a length
    // of time rather than "just now".
    const elapsed = describeDuration(Math.max(1000, Date.now() - startedAt));
    const since = resumed ? " since Discord last restarted" : "";

    if (seen.size === 0) {
        return capturing
            ? `Nothing matching in ${elapsed}${since} yet.${remainingText()}`
            : "Nothing was captured. Either no relevant dispatch fired, or this build routes them somewhere the probe cannot see.";
    }

    const rows = [...seen.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([type, count]) => `- \`${type}\` ×${count}`);

    return [
        `**Dispatches seen in ${elapsed}${since}** (connect, session and interaction families; media telemetry excluded):`,
        ...rows,
        remainingText().trim()
    ].filter(Boolean).join("\n");
}
