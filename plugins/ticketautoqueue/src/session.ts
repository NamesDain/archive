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
// such store, so the id comes from the CONNECTION_OPEN dispatch when that carries
// one, and from a module lookup otherwise.
//
// Nothing here is cached. A session id belongs to one gateway connection and the
// client issues a fresh one on every reconnect - which on mobile is every app
// switch. An earlier version remembered whatever the lookup first returned, so
// after the first reconnect every press went out under an id that no longer
// existed, and there was no local sign of it at all.

import { findByProps, findByStoreName } from "@vendetta/metro";

/** Only what CONNECTION_OPEN supplied; null once a connect arrives without one. */
let fromConnectionOpen: string | null = null;

let connectionOpens = 0;
let lastConnectionOpenAt = 0;

/** Which of the candidate events this build actually dispatches, and how often. */
const seenEvents = new Map<string, number>();

/**
 * Every dispatch that might mean "the gateway just came up".
 *
 * CONNECTION_OPEN is what the desktop client fires and what this plugin was
 * written against, but a device reported "Gateway connects seen: none since
 * load" while plainly reconnecting - so it does not fire here, and the reconnect
 * sweep never ran. Rather than guess which name replaced it, all the plausible
 * ones are subscribed and the status command reports which actually arrive.
 * Extra subscriptions cost nothing; a missing one costs every catch-up sweep.
 */
export const CONNECT_EVENTS = [
    "CONNECTION_OPEN",
    "CONNECTION_OPEN_SUPPLEMENTAL",
    "READY",
    "READY_SUPPLEMENTAL",
    "RESUMED",
    "SESSION_REPLACE",
    "GATEWAY_CONNECTED"
] as const;

/**
 * Called from the CONNECTION_OPEN handler. Every connect issues a fresh id, so a
 * connect that carries none must clear the previous one rather than leave it
 * standing - the old id is dead either way.
 */
export function rememberSessionId(eventName: string, event: any): void {
    connectionOpens++;
    lastConnectionOpenAt = Date.now();
    seenEvents.set(eventName, (seenEvents.get(eventName) ?? 0) + 1);

    // READY nests the payload; the others carry it flat, under either spelling.
    const id = event?.sessionId
        ?? event?.session_id
        ?? event?.sessionID
        ?? event?.ready?.session_id
        ?? event?.d?.session_id;

    // A connect that carries no id clears the previous one rather than leaving it
    // standing: a new connection invalidates the old id either way, and the live
    // lookup below is a better answer than a dead value.
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
 * None of the seven candidate connect events fire on current Discord iOS - a
 * device reported "none since load" with all of them subscribed. But the id
 * itself was observed changing between two status calls minutes apart, and a new
 * id means a new connection. Polling for that change detects a reconnect without
 * depending on the name of an event nobody has identified yet.
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

export function getSessionId(): string | null {
    if (fromConnectionOpen) return fromConnectionOpen;

    // Resolved fresh every time. The client's own value tracks the live connection;
    // holding on to a copy is precisely how it goes stale.
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

    if (fromConnectionOpen) {
        return { held: true, source: "CONNECTION_OPEN", hint: redact(fromConnectionOpen), ...base };
    }

    const id = getSessionId();
    if (id) return { held: true, source: "module lookup", hint: redact(id), ...base };

    return { held: false, source: "none", hint: "—", ...base };
}

/** Enough to tell two sessions apart in a report, not enough to reuse. */
function redact(id: string): string {
    return id.length <= 8 ? "********" : `${id.slice(0, 4)}…${id.slice(-4)} (${id.length} chars)`;
}
