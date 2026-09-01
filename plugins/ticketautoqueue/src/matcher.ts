/*
 * TicketAutoQueue for Kettu
 * Copyright (c) 2026 river and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * Ported from the Vencord plugin of the same name.
 */

import { getChannel } from "./discord";
import { parseIdList, parseLabelList, parsePattern, settings, ticketBotId } from "./settings";

export interface TicketTarget {
    channelId: string;
    guildId: string;
    messageId: string;
    customId: string;
    applicationId: string;
    messageFlags: number;
    channelName: string;
    label: string;
}

export type MatchResult =
    | { ok: true; target: TicketTarget; }
    | { ok: false; reason: string; };

const BUTTON = 2;
const LINK_STYLE = 5;

/**
 * Components V2 nests buttons inside containers, sections and accessories,
 * so a flat scan of message.components misses them.
 */
export function collectButtons(components: unknown): any[] {
    const out: any[] = [];
    const seen = new Set<any>();

    const visit = (nodes: unknown) => {
        if (!Array.isArray(nodes)) return;
        for (const node of nodes) {
            if (!node || typeof node !== "object" || seen.has(node)) continue;
            seen.add(node);
            const n = node as any;
            if (n.type === BUTTON) out.push(n);
            if (Array.isArray(n.components)) visit(n.components);
            if (n.accessory) visit([n.accessory]);
        }
    };

    visit(components);
    return out;
}

/**
 * A component's custom_id, whichever spelling this build stores it under.
 *
 * The mobile client normalises some snake_case gateway keys to camelCase on the
 * way into its stores. `/taq test` on a real ticket reported a live, enabled,
 * non-link button with "custom_id=none" while label, style and disabled all read
 * fine - and those three are the only single-word keys in that set. A non-link
 * button cannot legally lack the field, so it is present under the other name.
 * Raw REST responses keep snake_case, so both have to be accepted.
 */
export function customIdOf(node: any): string | undefined {
    const id = node?.custom_id ?? node?.customId;
    return typeof id === "string" && id !== "" ? id : undefined;
}

/** Same normalisation problem, same fix. */
export function applicationIdOf(message: any): string | undefined {
    const id = message?.application_id ?? message?.applicationId ?? message?.author?.id;
    return id ? String(id) : undefined;
}

function isPressable(btn: any, labels: string[]): boolean {
    if (btn.disabled) return false;
    if (btn.style === LINK_STYLE) return false;
    if (!customIdOf(btn)) return false;
    const label = String(btn.label ?? "").trim().toLowerCase();
    return label !== "" && labels.includes(label);
}

/**
 * @param knownChannel the channel record, when the caller already holds one.
 *
 * A sweep after waking from suspension is exactly when the channel store is
 * coldest, and it is also when it lists ticket channels from REST instead. Making
 * the store the only source turned every one of those into "channel not in store"
 * - so the REST fallback found the tickets and then could not match any of them.
 */
export function matchTicket(message: any, knownChannel?: any): MatchResult {
    const channelId = message?.channel_id ?? message?.channelId;
    if (!channelId) return { ok: false, reason: "no channel_id on message" };

    const categories = parseIdList(settings.categoryIds);
    if (categories.size === 0) return { ok: false, reason: "no categoryIds configured" };

    const channel = knownChannel ?? getChannel(String(channelId));
    if (!channel) return { ok: false, reason: "channel not in store" };
    const parentId = channel.parent_id ?? channel.parentId;
    if (!parentId || !categories.has(String(parentId))) {
        return { ok: false, reason: `category ${parentId ?? "none"} not watched` };
    }

    const pattern = parsePattern(settings.channelNamePattern);
    if (pattern && !pattern.test(channel.name ?? "")) {
        return { ok: false, reason: `channel name "${channel.name}" failed pattern` };
    }

    const botId = ticketBotId();
    if (botId && String(message.author?.id) !== botId) {
        return { ok: false, reason: `author ${message.author?.id} is not the configured ticket bot` };
    }

    const labels = parseLabelList(settings.buttonLabels);
    if (labels.length === 0) return { ok: false, reason: "no buttonLabels configured" };

    const button = collectButtons(message.components).find(b => isPressable(b, labels));
    if (!button) return { ok: false, reason: "no matching enabled button with a custom_id" };

    const applicationId = applicationIdOf(message);
    if (!applicationId) return { ok: false, reason: "could not resolve application_id" };

    return {
        ok: true,
        target: {
            channelId: String(channelId),
            guildId: String(channel.guild_id ?? channel.guildId),
            messageId: String(message.id),
            customId: customIdOf(button)!,
            applicationId: String(applicationId),
            messageFlags: message.flags ?? 0,
            channelName: channel.name ?? "",
            label: String(button.label)
        }
    };
}
