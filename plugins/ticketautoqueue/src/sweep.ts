/*
 * TicketAutoQueue for Kettu
 * Copyright (c) 2026 river and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * Ported from the Vencord plugin of the same name.
 */

import { logger } from "@vendetta";

import { press } from "./clicker";
import { cachedMessages, fetchGuildChannels, getChannel, listGuildChannels, RestAPI } from "./discord";
import { deadlinePassed, trackDraw } from "./draws";
import { allow, noteRejection, release, reserve } from "./gates";
import { matchTicket } from "./matcher";
import { withRateLimitRetry } from "./net";
import { parseIdList, settings } from "./settings";
import { isUnreachable, noteUnreachable } from "./unreachable";

const DISCORD_EPOCH = 1420070400000;
const FETCH_LIMIT = 20;
const FETCH_SPACING_MS = 400;

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

let sweeping = false;

/** Lets automatic callers skip silently instead of catching the "already running" throw. */
export function isSweeping(): boolean {
    return sweeping;
}

export interface SweepStats {
    candidates: number;
    joined: number;
    failed: number;
    skipped: number;
}

/** Snowflakes encode creation time, so channel age needs no API call. */
function createdAt(snowflake: string): number {
    return Number(BigInt(snowflake) >> 22n) + DISCORD_EPOCH;
}

/**
 * Every channel in the guild, from the store if any accessor exposes it and from
 * REST otherwise.
 *
 * Desktop could rely on GuildChannelStore.getSelectableChannels always being
 * there. Mobile has no such store, so a single guild-channels request is the
 * backstop - one call per guild per sweep, and sweeps are floored at a minute apart.
 */
async function guildChannels(guildId: string): Promise<any[]> {
    const fromStore = listGuildChannels(guildId);
    if (fromStore.length) return fromStore;

    if (settings.verboseLogging) {
        logger.info(`[SWEEP] no channel store accessor worked for guild ${guildId}; falling back to REST`);
    }

    try {
        return await withRateLimitRetry(`guild ${guildId} channels`, () => fetchGuildChannels(guildId));
    } catch (err) {
        logger.warn(`[SWEEP] could not list channels for guild ${guildId}:`, err);
        return [];
    }
}

async function watchedChannels(): Promise<any[]> {
    const categories = parseIdList(settings.categoryIds);
    if (categories.size === 0) return [];

    const guildIds = new Set<string>();
    for (const id of categories) {
        const guildId = getChannel(id)?.guild_id;
        if (guildId) guildIds.add(String(guildId));
    }

    const maxAge = Math.max(0, settings.catchUpMaxAgeMs);
    const cutoff = Date.now() - maxAge;
    const out: any[] = [];

    for (const guildId of guildIds) {
        for (const channel of await guildChannels(guildId)) {
            if (!channel?.parent_id || !categories.has(String(channel.parent_id))) continue;
            if (createdAt(channel.id) < cutoff) continue;
            out.push(channel);
        }
    }

    // Oldest first, so the longest-waiting customer is claimed first.
    return out.sort((a, b) => createdAt(a.id) - createdAt(b.id));
}

/**
 * `after: 0` returns the channel's oldest messages. The ticket panel is posted first,
 * so a newest-first fetch would miss it on any ticket with a page of chatter.
 */
async function panelMessages(channelId: string, channel: any): Promise<{ messages: any[]; hitNetwork: boolean; }> {
    // The panel is often already cached from simply having the channel open, and a
    // sweep issues one request per watched channel, so skipping the request when the
    // answer is already local is the difference between a burst and a trickle.
    const cachedPanel = cachedMessages(channelId).filter(m => matchTicket(m, channel).ok);
    if (cachedPanel.length) return { messages: cachedPanel, hitNetwork: false };

    const res = await withRateLimitRetry<any>(`fetch #${channelId}`, () => RestAPI().get({
        url: `/channels/${channelId}/messages`,
        query: { limit: FETCH_LIMIT, after: "0" }
    }));
    return { messages: (res?.body ?? []) as any[], hitNetwork: true };
}

/**
 * Joins queues on tickets that were already open. Runs strictly sequentially:
 * a burst of parallel interactions is both rate-limit bait and obviously automated.
 */
export async function sweepOpenTickets(): Promise<SweepStats> {
    if (sweeping) throw new Error("a sweep is already running");
    sweeping = true;

    const stats: SweepStats = { candidates: 0, joined: 0, failed: 0, skipped: 0 };

    try {
        const channels = await watchedChannels();
        stats.candidates = channels.length;

        for (const channel of channels) {
            // Cheapest possible check, and the one that protects the invalid-request budget.
            if (isUnreachable(channel.id)) {
                stats.skipped++;
                if (settings.verboseLogging) logger.info(`[SWEEP] skip #${channel.name}: previously unreadable`);
                continue;
            }

            const gate = allow(channel.id);
            if (!gate.ok) {
                stats.skipped++;
                if (settings.verboseLogging) logger.info(`[SWEEP] skip #${channel.name}: ${gate.reason}`);
                continue;
            }

            let messages: any[];
            let hitNetwork: boolean;
            try {
                ({ messages, hitNetwork } = await panelMessages(channel.id, channel));
            } catch (err) {
                stats.skipped++;
                const cached = noteUnreachable(channel.id, (err as any)?.status);
                logger.warn(`[SWEEP] could not read #${channel.name}${cached ? " (will not retry this hour)" : ""}:`, err);
                continue;
            }

            let matched = false;
            let pressed = false;
            let expired = false;
            for (const message of messages) {
                const match = matchTicket(message, channel);
                if (!match.ok) continue;

                // A sweep looks back an hour, but a draw closes in about a minute. Pressing
                // Join Queue on one that already resolved is a wasted interaction against a
                // dead panel - the single most obviously automated thing this plugin could do.
                if (deadlinePassed(message)) {
                    expired = true;
                    continue;
                }
                matched = true;

                const { target } = match;
                pressed = true;
                reserve(target.channelId);

                const result = await press(target);
                if (result === "joined" || result === "sent") {
                    stats.joined++;
                    trackDraw(target.channelId, target.channelName, settings.drawWatchWindowMs);
                    logger.info(`[SWEEP] ${result === "joined" ? "joined" : "sent press for"} "${target.label}" in #${target.channelName}`);
                } else {
                    release(target.channelId);
                    if (result === "rejected") noteRejection(target.channelId);
                    stats.failed++;
                    logger.error(`[SWEEP] failed to press "${target.label}" in #${target.channelName} (${result})`);
                }
                break;
            }

            if (!matched) {
                stats.skipped++;
                if (settings.verboseLogging) {
                    logger.info(expired
                        ? `[SWEEP] draw already closed in #${channel.name}`
                        : `[SWEEP] no joinable panel in #${channel.name}`);
                }
            }

            // Pacing only buys something when we actually touched the network or the
            // bot. A cache hit that found nothing costs Discord nothing to sleep after.
            if (hitNetwork || pressed) {
                await sleep(FETCH_SPACING_MS + Math.max(0, settings.cooldownMs));
            }
        }
    } finally {
        sweeping = false;
    }

    return stats;
}
