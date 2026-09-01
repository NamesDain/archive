/*
 * TicketAutoQueue for Kettu
 * Copyright (c) 2026 river and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * Ported from the Vencord plugin of the same name.
 */

import { logger } from "@vendetta";

const MAX_RETRIES = 2;
const MIN_WAIT_MS = 250;
const MAX_WAIT_MS = 60000;

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

/**
 * Retries a request that came back 429.
 *
 * Two reasons this matters more than it looks. A sweep issues one message fetch per
 * watched channel in a loop, which is exactly the shape that trips a per-route limit.
 * And repeatedly ignoring 429s counts toward Discord's invalid-request budget, which
 * is enforced at the edge against the whole client, not just this plugin.
 */
export async function withRateLimitRetry<T>(label: string, fn: () => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
        try {
            return await fn();
        } catch (err: any) {
            if (err?.status !== 429 || attempt >= MAX_RETRIES) throw err;

            // Discord sends retry_after on REST 429s as a float in SECONDS.
            const seconds = Number(err?.body?.retry_after);
            const waitMs = Math.min(
                MAX_WAIT_MS,
                Math.max(MIN_WAIT_MS, Number.isFinite(seconds) ? Math.ceil(seconds * 1000) + MIN_WAIT_MS : 1000)
            );

            logger.warn(`Rate limited on ${label}; waiting ${waitMs}ms then retrying (attempt ${attempt + 1}/${MAX_RETRIES}).`);
            await sleep(waitMs);
        }
    }
}
