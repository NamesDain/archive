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
//
// A 15-minute /taq events capture on the device settled the question this file
// was written not knowing the answer to: INTERACTION_CREATE and INTERACTION_SUCCESS
// both fire on current Discord iOS. So outcomes are reported here, and everything
// below is live rather than a path that might never run. What that capture cannot
// say is whether the outcome carries the nonce back, which is why a press is now
// identifiable both ways - see resolve().

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

/**
 * Whether an outcome has ever come back carrying the nonce that was sent.
 *
 * This decides what a timeout means. If outcomes are matched by nonce, one that
 * never arrives is evidence the press was dropped, and a retry is warranted. If
 * they arrive without it, a timeout only means the outcome could not be tied to
 * a press - and retrying every press on that would hammer a bot that is already
 * struggling.
 */
let nonceEchoed = false;

function nonceOf(event: any): string | undefined {
    const nonce = event?.nonce ?? event?.interaction?.nonce ?? event?.interactionNonce;
    return nonce === undefined || nonce === null ? undefined : String(nonce);
}

function settleWaiter(nonce: string, waiter: Waiter, outcome: Outcome): void {
    clearTimeout(waiter.timer);
    waiting.delete(nonce);
    waiter.settle(outcome);
}

function resolve(event: any, outcome: Outcome): void {
    outcomesObserved = true;

    const nonce = nonceOf(event);
    if (nonce !== undefined) {
        // A nonce that is not one of ours belongs to a different press - a manual
        // tap somewhere else in the client - and settling on it would report that
        // press's outcome as this one's.
        const waiter = waiting.get(nonce);
        if (!waiter) return;

        nonceEchoed = true;
        settleWaiter(nonce, waiter, outcome);
        return;
    }

    // No nonce came back. The press is still identifiable whenever exactly one is
    // in flight, which is the ordinary case here: presses are seconds apart and
    // the window is four. Dropping the outcome instead would leave every press to
    // time out, and a timeout after an outcome has been seen used to be reported
    // as a rejection - so a build that reports outcomes without the nonce would
    // have had every successful press counted as one the bot ignored.
    if (waiting.size !== 1) return;

    const [[only, waiter]] = [...waiting];
    settleWaiter(only, waiter, outcome);
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
            // "rejected" claims the bot dropped this press, and only a build that
            // ties outcomes back to a press by nonce supports that claim. A client
            // that has never reported an outcome, or reports them without saying
            // which press they belong to, is not evidence of a failed press.
            settle(outcomesObserved && nonceEchoed ? "rejected" : "unknown");
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

/**
 * How outcomes are being matched to presses, for the status report. Whether the
 * nonce comes back decides whether a retry can be justified, so it is worth
 * being able to read off the device rather than inferred.
 */
export function outcomeMatching(): "nonce" | "in-flight" {
    return nonceEchoed ? "nonce" : "in-flight";
}

/** Test seam; also keeps a reload from inheriting the previous session's verdict. */
export function resetInteractionWatch(): void {
    outcomesObserved = false;
    timedOutWithoutAnyOutcome = false;
    nonceEchoed = false;
}
