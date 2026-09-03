/*
 * TicketAutoQueue for Kettu
 * Copyright (c) 2026 river and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * Ported from the Vencord plugin of the same name.
 */

// The desktop plugin pressed the button two ways: an /interactions POST, and a
// DOM click on the rendered message if that failed. React Native has no DOM, so
// the fallback is gone and the REST path is the only one. Everything it needs is
// on the message itself except session_id - see session.ts for where that comes
// from and why its absence is reported as its own failure rather than a 400.

import { logger } from "@vendetta";

import { cachedMessage, RestAPI } from "./discord";
import { collectButtons, customIdOf, TicketTarget } from "./matcher";
import { withRateLimitRetry } from "./net";
import { awaitOutcome, Outcome } from "./interactions";
import { getSessionId } from "./session";
import { settings } from "./settings";

const MESSAGE_COMPONENT = 3;
const COMPONENT_TYPE_BUTTON = 2;

/**
 * - joined:     the client confirmed the bot acted on the press.
 * - sent:       accepted for delivery, nothing further known - either this build
 *               reports no outcome, or the panel changed before a retry.
 * - rejected:   the bot ignored or refused every attempt.
 * - failed:     the request itself did not get through.
 * - no-session: no gateway session, so no press is possible.
 */
export type PressResult = "joined" | "sent" | "rejected" | "failed" | "no-session";

function generateNonce(): string {
    // Snowflake-shaped, and unique per press rather than per millisecond: the
    // client matches an outcome back to a press by this value, so two presses
    // sharing one would have the second's outcome settle the first.
    const ms = BigInt(Date.now() - 1420070400000) << 22n;
    return String(ms | BigInt(Math.floor(Math.random() * 4194304)));
}

export async function clickViaApi(target: TicketTarget, sessionId: string, nonce: string): Promise<any> {
    return withRateLimitRetry<any>("interaction", () => RestAPI().post({
        url: "/interactions",
        body: {
            type: MESSAGE_COMPONENT,
            nonce,
            guild_id: target.guildId,
            channel_id: target.channelId,
            message_id: target.messageId,
            message_flags: target.messageFlags,
            application_id: target.applicationId,
            session_id: sessionId,
            data: {
                component_type: COMPONENT_TYPE_BUTTON,
                custom_id: target.customId
            }
        }
    }));
}

// Discord gives an application three seconds to answer before the client marks
// the interaction failed, so there is no point waiting much longer than that.
const OUTCOME_TIMEOUT_MS = 4000;

// The ticket bot drops presses on some tickets - manual taps included - and a
// retry usually takes. Kept small: this is a bot that is struggling, and the
// draw closes in about a minute, so a long ladder of attempts would still be
// pressing after the queue had been decided.
const MAX_ATTEMPTS = 3;
const RETRY_DELAY_MS = 1200;

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

/**
 * Whether the button we pressed is still on the panel.
 *
 * A retry exists for a press the bot dropped, but "the bot never answered" and
 * "the bot acted and took longer than the client's three seconds to say so" are
 * indistinguishable from here - both surface as an interaction failure. The panel
 * tells them apart: this bot replaces Join Queue with Leave Queue once you are in,
 * so a button that has gone is a press that landed.
 *
 * Pressing again in that state is the thing worth avoiding. It is at best a
 * needless interaction at a bot already struggling, and at worst - if the bot
 * treats one custom_id as a toggle - it joins the queue and then leaves it.
 *
 * Not cached is treated as still there: a cold store must not quietly disable
 * retries, which is the whole reason the outcome watch exists.
 */
function buttonStillOnPanel(target: TicketTarget): boolean {
    const message = cachedMessage(target.channelId, target.messageId);
    if (!message) return true;

    return collectButtons(message.components)
        .some(button => customIdOf(button) === target.customId && !button.disabled);
}

/**
 * Sends the button press and waits to hear what became of it.
 *
 * The REST response alone cannot settle this: Discord answers as soon as it has
 * accepted the interaction for delivery, identically whether or not the bot then
 * handles it. The client's own outcome dispatch is the only local evidence, and
 * it is what "joined" is reported from - so a join is claimed only when something
 * actually confirmed one.
 *
 * "sent" is the weaker claim - the request was accepted and nothing more is known
 * - and covers two cases: a build that reports no outcome at all, and a panel
 * whose button has gone before a retry, where the press evidently landed but
 * nothing local confirmed it.
 */
export async function press(target: TicketTarget): Promise<PressResult> {
    const sessionId = getSessionId();
    if (!sessionId) {
        // Distinguished from a generic failure because the fix is different: this
        // one clears itself on the next gateway connect, and retrying now cannot help.
        logger.error("No gateway session id available; cannot dispatch the interaction.");
        return "no-session";
    }

    let lastOutcome: Outcome = "unknown";

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        const nonce = generateNonce();
        const outcome = awaitOutcome(nonce, OUTCOME_TIMEOUT_MS);

        try {
            const res = await clickViaApi(target, sessionId, nonce);
            if (settings.verboseLogging) {
                logger.info(`Interaction accepted for "${target.label}" in #${target.channelName} (HTTP ${res?.status ?? "?"}), attempt ${attempt}/${MAX_ATTEMPTS}`);
            }
        } catch (err) {
            logger.error(`Interaction dispatch failed on attempt ${attempt}:`, err);
            return "failed";
        }

        lastOutcome = await outcome;

        if (lastOutcome === "joined") {
            logger.info(`Joined the queue in #${target.channelName} on attempt ${attempt}.`);
            return "joined";
        }

        // Nothing to retry on: this build never reports outcomes, so a timeout is
        // not evidence the press was dropped.
        if (lastOutcome === "unknown") return "sent";

        if (attempt < MAX_ATTEMPTS) {
            if (!buttonStillOnPanel(target)) {
                logger.info(`"${target.label}" is no longer on the panel in #${target.channelName}, so the press landed after all; not retrying.`);
                return "sent";
            }

            logger.warn(`The bot did not act on the press in #${target.channelName} (attempt ${attempt}/${MAX_ATTEMPTS}); retrying.`);
            await sleep(RETRY_DELAY_MS);
        }
    }

    logger.error(`The bot rejected or ignored every press in #${target.channelName} after ${MAX_ATTEMPTS} attempts.`);
    return "rejected";
}
