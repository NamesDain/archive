/*
 * TicketAutoQueue for Kettu
 * Copyright (c) 2026 river and contributors
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * Ported from the Vencord plugin of the same name.
 */

// Discord rejects a component interaction that carries no session_id, and quietly
// fails to route the bot's reply back for one carrying a stale id - which shows up
// only as "This interaction failed" under the message.
//
// Vencord reads it straight off AuthenticationStore.getSessionId(). Mobile has no
// store by that name, but a module lookup does answer here, and that is the value
// presses go out under. A connect dispatch's id is kept only for a build where no
// lookup answers at all.
//
// Nothing here is cached. A session id belongs to one gateway connection and the
// client issues a fresh one on every reconnect - which on mobile is every app
// switch. An earlier version remembered whatever the lookup first returned, so
// after the first reconnect every press went out under an id that no longer
// existed, and there was no local sign of it at all.

import { findByProps, findByStoreName } from "@vendetta/metro";

/**
 * The id a connect dispatch supplied, kept only as a fallback.
 *
 * The live lookup is preferred over this, because this is a snapshot: it is
 * right when it is written and wrong from the next reconnect onwards, and the
 * client's own value is never either.
 */
let fromConnectionOpen: string | null = null;

let connectionOpens = 0;
let lastConnectionOpenAt = 0;

/** Which of the candidate events this build actually dispatches, and how often. */
const seenEvents = new Map<string, number>();

/**
 * Every dispatch that might mean "the gateway just came up".
 *
 * This list was guessed at twice and wrong twice, so it is now built from what a
 * /taq events capture on the device actually recorded. A 15-minute window caught
 * all of these, most frequent first:
 *
 *   SESSIONS_REPLACE ×16, CONNECTION_RESUMED ×11, POST_CONNECTION_OPEN ×4,
 *   CONNECTION_OPEN ×3, CONNECTION_OPEN_SUPPLEMENTAL ×3
 *
 * CONNECTION_OPEN does fire here after all. An earlier two-minute capture missed
 * it and this file went on to state as fact that it never fires on current
 * Discord iOS - it was a window too short to contain a reconnect, not evidence of
 * absence. The near-misses from the guessing (RESUMED, SESSION_REPLACE) are kept:
 * they cost one subscription each, other builds may use them, and this list being
 * wrong is what caused the original problem.
 *
 * The rate is worth reading too: eleven resumes in a quarter of an hour is the
 * gateway coming back after each app switch, which is exactly when a catch-up
 * sweep should run.
 */
export const CONNECT_EVENTS = [
    "CONNECTION_OPEN",
    "POST_CONNECTION_OPEN",
    "CONNECTION_OPEN_SUPPLEMENTAL",
    "CONNECTION_RESUMED",
    "SESSIONS_REPLACE",
    "READY",
    "READY_SUPPLEMENTAL",
    "RESUMED",
    "SESSION_REPLACE",
    "GATEWAY_CONNECTED"
] as const;

/**
 * The ones in that list that are not a connection opening.
 *
 * SESSIONS_REPLACE is the user's session list being replaced, which happens when
 * any other device connects or changes presence - sixteen times in the capture
 * above, more often than anything else. It is still worth sweeping on, since a
 * wake is a wake, but it does not issue a new session id, and treating it as a
 * connect meant it cleared a perfectly good one every time it fired.
 */
const NOT_A_CONNECTION = new Set(["SESSIONS_REPLACE", "SESSION_REPLACE"]);

/**
 * Called from every connect handler. A connection opening issues a fresh id, so
 * one that carries none must clear the previous one rather than leave it
 * standing - the old id is dead either way.
 */
export function rememberSessionId(eventName: string, event: any): void {
    connectionOpens++;
    lastConnectionOpenAt = Date.now();
    seenEvents.set(eventName, (seenEvents.get(eventName) ?? 0) + 1);

    if (NOT_A_CONNECTION.has(eventName)) return;

    // READY nests the payload; the others carry it flat, under either spelling.
    const id = event?.sessionId
        ?? event?.session_id
        ?? event?.sessionID
        ?? event?.ready?.session_id
        ?? event?.d?.session_id;

    fromConnectionOpen = id ? String(id) : null;
}

export function forgetSessionId(): void {
    fromConnectionOpen = null;
    connectionOpens = 0;
    lastConnectionOpenAt = 0;
    seenEvents.clear();
    sessionChanges = 0;
}

let sessionChanges = 0;

/**
 * Reconnects noticed by the session id changing rather than by a dispatch.
 *
 * This was written when no candidate connect event had ever been seen to fire,
 * and the id changing between two status calls was the only evidence a reconnect
 * had happened at all. Five of them are now known to fire, so this is no longer
 * the only signal - but it stays, because it depends on no event name being
 * right, and every previous list of names here has been wrong.
 */
export function noteSessionChange(): void {
    sessionChanges++;
}

export function sessionChangeCount(): number {
    return sessionChanges;
}

/** Which connect events this build fires, most frequent first. */
export function observedConnectEvents(): string[] {
    return [...seenEvents.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([name, count]) => `${name}×${count}`);
}

/**
 * The client's own value, resolved fresh every time. It tracks the live
 * connection; holding on to a copy is precisely how it goes stale.
 */
function lookupSessionId(): string | null {
    const candidates: Array<() => any> = [
        () => findByProps("getSessionId")?.getSessionId?.(),
        () => (findByStoreName("SessionStore") as any)?.getSessionId?.(),
        () => (findByStoreName("AuthenticationStore") as any)?.getSessionId?.()
    ];

    for (const candidate of candidates) {
        try {
            const id = candidate();
            if (id) return String(id);
        } catch { /* try the next one */ }
    }

    return null;
}

/**
 * The live lookup first, and only then the id a connect dispatch carried.
 *
 * That order is not a preference, it is what keeps two things working. The
 * remembered id is a snapshot that the next reconnect invalidates, where the
 * lookup is never stale - and it is also what the reconnect backstop watches for
 * a change, so a remembered value shadowing it would freeze the one signal that
 * needs no event name to be right. It survives here as the fallback for a build
 * where no lookup answers, which is the only case it was ever needed for.
 */
export function getSessionId(): string | null {
    return lookupSessionId() ?? fromConnectionOpen;
}

/**
 * What the status command reports.
 *
 * The id itself is never shown in full - it is a live credential for this
 * connection - but whether one is held, where it came from, and whether
 * CONNECTION_OPEN is firing at all are the first things to check when Discord
 * accepts an interaction and the bot never acts on it.
 */
export function sessionStatus(): {
    held: boolean;
    source: string;
    hint: string;
    connectionOpens: number;
    lastConnectionOpenAt: number;
} {
    const base = { connectionOpens, lastConnectionOpenAt };

    // Reported in the order getSessionId resolves them, so the status line names
    // the id a press would actually go out under.
    const live = lookupSessionId();
    if (live) return { held: true, source: "module lookup", hint: redact(live), ...base };

    if (fromConnectionOpen) {
        return { held: true, source: "a connect dispatch", hint: redact(fromConnectionOpen), ...base };
    }

    return { held: false, source: "none", hint: "—", ...base };
}

/** Enough to tell two sessions apart in a report, not enough to reuse. */
function redact(id: string): string {
    return id.length <= 8 ? "********" : `${id.slice(0, 4)}…${id.slice(-4)} (${id.length} chars)`;
}
