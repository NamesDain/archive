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

// Only the families with an open question against them. Capturing every dispatch
// would bury those in the hundreds of routine ones a client fires per minute.
const INTERESTING = /CONNECT|READY|RESUME|SESSION|GATEWAY|SOCKET|INTERACTION/i;

// Voice and media telemetry matches the filter on "CONNECTION" and fires roughly
// ten times a minute regardless of anything this plugin cares about. Two capture
// runs so far have been mostly this.
const NOISE = /^MEDIA_ENGINE|^VOICE_|^AUDIO_|_STATS$/i;

// A cap, so a pathological run cannot grow this without bound.
const MAX_TYPES = 100;

const seen = new Map<string, number>();

let installed = false;
let capturing = false;
let startedAt = 0;
let stopsAt = 0;
let stopTimer: ReturnType<typeof setTimeout> | null = null;

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
    startedAt = Date.now();
    stopsAt = startedAt + durationMs;
    capturing = true;

    if (stopTimer !== null) clearTimeout(stopTimer);
    stopTimer = setTimeout(stopProbe, durationMs);
    return true;
}

export function stopProbe(): void {
    capturing = false;
    stopsAt = 0;
    if (stopTimer !== null) clearTimeout(stopTimer);
    stopTimer = null;
}

function remainingText(): string {
    if (!capturing || stopsAt === 0) return "";
    const left = Math.max(0, Math.round((stopsAt - Date.now()) / 60000));
    return ` Still watching for another ${left} min — run this again any time for an updated list.`;
}

export function probeReport(): string {
    const elapsed = Math.round((Date.now() - startedAt) / 1000);

    if (seen.size === 0) {
        return capturing
            ? `Nothing matching in ${elapsed}s yet.${remainingText()}`
            : "Nothing was captured. Either no relevant dispatch fired, or this build routes them somewhere the probe cannot see.";
    }

    const rows = [...seen.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([type, count]) => `- \`${type}\` ×${count}`);

    return [
        `**Dispatches seen in ${elapsed}s** (connect, session and interaction families; media telemetry excluded):`,
        ...rows,
        remainingText().trim()
    ].filter(Boolean).join("\n");
}

export function resetProbe(): void {
    stopProbe();
    seen.clear();
    startedAt = 0;
    stopsAt = 0;
}
