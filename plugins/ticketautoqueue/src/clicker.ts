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

import { RestAPI } from "./discord";
import { TicketTarget } from "./matcher";
import { withRateLimitRetry } from "./net";
import { getSessionId } from "./session";

const MESSAGE_COMPONENT = 3;
const COMPONENT_TYPE_BUTTON = 2;

export type PressResult = "api" | "failed" | "no-session";

function generateNonce(): string {
    // Discord only requires per-request uniqueness here.
    return String(BigInt(Date.now() - 1420070400000) << 22n);
}

export async function clickViaApi(target: TicketTarget, sessionId: string): Promise<void> {
    await withRateLimitRetry("interaction", () => RestAPI().post({
        url: "/interactions",
        body: {
            type: MESSAGE_COMPONENT,
            nonce: generateNonce(),
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

export async function press(target: TicketTarget): Promise<PressResult> {
    const sessionId = getSessionId();
    if (!sessionId) {
        // Distinguished from a generic failure because the fix is different: this
        // one clears itself on the next gateway connect, and retrying now cannot help.
        logger.error("No gateway session id available; cannot dispatch the interaction.");
        return "no-session";
    }

    try {
        await clickViaApi(target, sessionId);
        return "api";
    } catch (err) {
        logger.error("Interaction dispatch failed:", err);
        return "failed";
    }
}
