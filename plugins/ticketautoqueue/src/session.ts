/*
 * TicketAutoQueue for Kettu
 * Copyright (c) 2026 river and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * Ported from the Vencord plugin of the same name.
 */

// Discord rejects a component interaction that carries no session_id, so this is
// load-bearing rather than incidental metadata.
//
// Vencord reads it straight off AuthenticationStore.getSessionId(). The mobile
// client has no such store, so the id is taken from the CONNECTION_OPEN dispatch
// that carries it - which the plugin already subscribes to for reconnect sweeps -
// and the module lookups below only exist to cover a plugin started mid-session,
// after that dispatch has already been and gone.

import { findByProps, findByStoreName } from "@vendetta/metro";

let sessionId: string | null = null;

/** Called from the CONNECTION_OPEN handler. Every connect issues a fresh id. */
export function rememberSessionId(event: any): void {
    const id = event?.sessionId ?? event?.session_id;
    if (id) sessionId = String(id);
}

export function forgetSessionId(): void {
    sessionId = null;
}

export function getSessionId(): string | null {
    if (sessionId) return sessionId;

    const candidates: Array<() => any> = [
        () => findByProps("getSessionId")?.getSessionId?.(),
        () => (findByStoreName("SessionStore") as any)?.getSessionId?.(),
        () => (findByStoreName("AuthenticationStore") as any)?.getSessionId?.()
    ];

    for (const candidate of candidates) {
        try {
            const id = candidate();
            if (id) return (sessionId = String(id));
        } catch { /* try the next one */ }
    }

    return null;
}
