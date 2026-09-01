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

function isPressable(btn: any, labels: string[]): boolean {
    if (btn.disabled) return false;
    if (btn.style === LINK_STYLE) return false;
    if (!btn.custom_id) return false;
    const label = String(btn.label ?? "").trim().toLowerCase();
    return label !== "" && labels.includes(label);
}

export function matchTicket(message: any): MatchResult {
    if (!message?.channel_id) return { ok: false, reason: "no channel_id on message" };

    const categories = parseIdList(settings.categoryIds);
    if (categories.size === 0) return { ok: false, reason: "no categoryIds configured" };

    const channel = getChannel(message.channel_id);
    if (!channel) return { ok: false, reason: "channel not in store" };
    if (!channel.parent_id || !categories.has(String(channel.parent_id))) {
        return { ok: false, reason: `category ${channel.parent_id ?? "none"} not watched` };
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

    const applicationId = message.application_id ?? message.author?.id;
    if (!applicationId) return { ok: false, reason: "could not resolve application_id" };

    return {
        ok: true,
        target: {
            channelId: String(message.channel_id),
            guildId: String(channel.guild_id),
            messageId: String(message.id),
            customId: button.custom_id,
            applicationId: String(applicationId),
            messageFlags: message.flags ?? 0,
            channelName: channel.name ?? "",
            label: String(button.label)
        }
    };
}
