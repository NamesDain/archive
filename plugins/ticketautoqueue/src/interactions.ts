/*
 * TicketAutoQueue for Kettu
 * Copyright (c) 2026 river and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * Ported from the Vencord plugin of the same name.
 */

// Knowing whether a press actually landed.
//
// The REST response cannot tell us: Discord answers /interactions as soon as it
// accepts the press for delivery, so a 204 arrives just the same when the bot
// never handles it. What does know is the client itself - it renders "This
// interaction failed" under the message, and it does that off a dispatch. Both
// outcomes are matched back to the press by the nonce we sent.
//
// This is what makes a retry possible at all, and a retry is the point: the
// ticket bot drops presses on some tickets, for manual taps as well as ours, and
// without this a dropped press is a ticket silently never joined.

import { logger } from "@vendetta";
import { FluxDispatcher } from "@vendetta/metro/common";

export type Outcome = "joined" | "rejected" | "unknown";

const SUCCESS_EVENTS = ["INTERACTION_SUCCESS"] as const;
const FAILURE_EVENTS = ["INTERACTION_FAILURE", "INTERACTION_FAILED"] as const;

interface Waiter {
    settle: (outcome: Outcome) => void;
    timer: ReturnType<typeof setTimeout>;
}

const waiting = new Map<string, Waiter>();

/**
 * Whether this client has ever dispatched an interaction outcome.
 *
 * If it never does, every press would time out and look like a failure, and
 * retrying all of them would hammer the bot for no reason. Until one is seen, a
 * timeout is reported as "unknown" and nothing is retried on the strength of it.
 */
let outcomesObserved = false;

/**
 * Set the first time a press times out having never seen any outcome. Together
 * with outcomesObserved staying false, it means this build does not report them
 * at all, and later presses should not wait to rediscover that.
 */
let timedOutWithoutAnyOutcome = false;

function nonceOf(event: any): string | undefined {
    const nonce = event?.nonce ?? event?.interaction?.nonce ?? event?.interactionNonce;
    return nonce === undefined || nonce === null ? undefined : String(nonce);
}

function resolve(event: any, outcome: Outcome): void {
    outcomesObserved = true;

    const nonce = nonceOf(event);
    if (!nonce) return;

    const waiter = waiting.get(nonce);
    if (!waiter) return;

    clearTimeout(waiter.timer);
    waiting.delete(nonce);
    waiter.settle(outcome);
}

const onSuccess = (event: any) => {
    try {
        resolve(event, "joined");
    } catch (err) {
        logger.error("INTERACTION_SUCCESS handler threw:", err);
    }
};

const onFailure = (event: any) => {
    try {
        resolve(event, "rejected");
    } catch (err) {
        logger.error("INTERACTION_FAILURE handler threw:", err);
    }
};

export function startInteractionWatch(): void {
    for (const event of SUCCESS_EVENTS) FluxDispatcher.subscribe(event, onSuccess);
    for (const event of FAILURE_EVENTS) FluxDispatcher.subscribe(event, onFailure);
}

export function stopInteractionWatch(): void {
    for (const event of SUCCESS_EVENTS) FluxDispatcher.unsubscribe(event, onSuccess);
    for (const event of FAILURE_EVENTS) FluxDispatcher.unsubscribe(event, onFailure);

    for (const [nonce, waiter] of [...waiting]) {
        clearTimeout(waiter.timer);
        waiting.delete(nonce);
        waiter.settle("unknown");
    }
}

/**
 * Resolves once the client reports what became of the press, or on timeout.
 *
 * Discord gives an application three seconds to answer an interaction before the
 * client gives up on it, so a window a little past that is all the evidence there
 * is going to be.
 */
export function awaitOutcome(nonce: string, timeoutMs: number): Promise<Outcome> {
    // Once a press has timed out with no outcome ever seen, this build does not
    // report them, and every later press would pay the same wait to learn the same
    // thing. On a draw that closes in about a minute, spending four seconds of it
    // waiting for a dispatch that is never coming is worse than not knowing sooner
    // - and a sweep pays it once per channel. One press establishes it; the rest
    // return at once.
    if (!outcomesObserved && timedOutWithoutAnyOutcome) {
        return Promise.resolve<Outcome>("unknown");
    }

    return new Promise<Outcome>(settle => {
        const timer = setTimeout(() => {
            waiting.delete(nonce);
            if (!outcomesObserved) timedOutWithoutAnyOutcome = true;
            // A client that has never reported an outcome is not evidence of a
            // failed press, only of a client that does not report.
            settle(outcomesObserved ? "rejected" : "unknown");
        }, timeoutMs);

        waiting.set(nonce, { settle, timer });
    });
}

/** For the status command: whether outcome reporting works on this build at all. */
export function outcomeReportingSeen(): boolean {
    return outcomesObserved;
}

/** True once a press has proved this build never reports outcomes. */
export function outcomeReportingRuledOut(): boolean {
    return !outcomesObserved && timedOutWithoutAnyOutcome;
}

/** Test seam; also keeps a reload from inheriting the previous session's verdict. */
export function resetInteractionWatch(): void {
    outcomesObserved = false;
    timedOutWithoutAnyOutcome = false;
}
