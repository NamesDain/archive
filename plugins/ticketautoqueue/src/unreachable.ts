/*
 * TicketAutoQueue for Kettu
 * Copyright (c) 2026 river and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * Ported from the Vencord plugin of the same name.
 */

// Zero imports, relative ones included, so Node can run this directly under test.

/**
 * Remembers channels a fetch has already failed on with a status that will not change
 * on a retry any time soon.
 *
 * 401 and 403 are the ones that actually matter. Discord counts those - together with
 * 429 - toward a budget of 10,000 invalid requests per 10 minutes per IP, and blowing
 * that budget gets the whole client Cloudflare-banned, not just this plugin. A sweep
 * that keeps re-reading a channel it has lost access to is the cheapest possible way
 * to spend that budget for nothing. 404 costs nothing but is equally pointless.
 *
 * Everything else - 5xx, timeouts, 429 - is deliberately not cached, because those do
 * change on a retry and the retry path already handles them.
 */
const HARD_STATUSES = new Set([401, 403, 404]);

/** Long enough to cover a whole sweep cycle, short enough that a restored permission heals itself. */
export const DEFAULT_TTL_MS = 3600000;

const blocked = new Map<string, number>();

/**
 * Records a failure if its status is one worth remembering.
 * Returns whether it was recorded, so the caller can log the two cases differently.
 */
export function noteUnreachable(channelId: string, status: unknown, now = Date.now(), ttlMs = DEFAULT_TTL_MS): boolean {
    if (!channelId || !HARD_STATUSES.has(Number(status))) return false;
    blocked.set(channelId, now + Math.max(0, ttlMs));
    return true;
}

export function isUnreachable(channelId: string, now = Date.now()): boolean {
    const until = blocked.get(channelId);
    if (until === undefined) return false;
    if (until > now) return true;
    blocked.delete(channelId);
    return false;
}

/** Live entries only; expired ones are dropped as a side effect. */
export function unreachableCount(now = Date.now()): number {
    let live = 0;
    for (const [id, until] of [...blocked.entries()]) {
        if (until > now) live++;
        else blocked.delete(id);
    }
    return live;
}

export function clearUnreachable(): void {
    blocked.clear();
}
