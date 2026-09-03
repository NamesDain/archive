/*
 * TicketAutoQueue for Kettu
 * Copyright (c) 2026 river and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * Ported from the Vencord plugin of the same name.
 */

// Every lookup into Discord's own modules lives here, so the rest of the plugin
// never touches metro directly. Desktop Vencord could import these from
// @webpack/common by name; on mobile they have to be found by shape, and a few
// of them do not exist at all - see listGuildChannels and cachedMessages.

import { findByProps, findByStoreName } from "@vendetta/metro";

/**
 * Metro is populated by the time a plugin is evaluated, but a module that has
 * not been required yet resolves to undefined and stays that way if we cache it.
 * Resolving on first use and only memoising a hit avoids baking in a miss.
 */
function lazy<T>(resolve: () => T): () => T {
    let cached: T | undefined;
    return () => {
        if (cached === undefined) cached = resolve();
        return cached as T;
    };
}

// Discord's own modules carry no useful types, so these are `any` by necessity
// rather than by shortcut - vendetta-types resolves both finders to `{}`.
export const ChannelStore = lazy<any>(() => findByStoreName("ChannelStore"));
export const MessageStore = lazy<any>(() => findByStoreName("MessageStore"));
export const UserStore = lazy<any>(() => findByStoreName("UserStore"));
export const SelectedChannelStore = lazy<any>(() => findByStoreName("SelectedChannelStore"));

/** Same shape as Vencord's RestAPI: get/post/put/patch/del taking { url, body, query }. */
export const RestAPI = lazy<any>(() => findByProps("getAPIBaseURL", "del"));

export const MessageActions = lazy<any>(() => findByProps("sendBotMessage"));

export function getChannel(channelId: string): any {
    return ChannelStore()?.getChannel?.(channelId);
}

export function getCurrentUserId(): string | null {
    const id = UserStore()?.getCurrentUser?.()?.id;
    return id ? String(id) : null;
}

/**
 * Messages the client already holds for a channel.
 *
 * Vencord reads `MessageStore.getMessages(id)._array` directly. The mobile store
 * returns the same collection type, but `_array` is an implementation detail that
 * has moved before, so the documented accessors are tried first and a miss just
 * means "nothing cached" rather than a crash.
 */
export function cachedMessages(channelId: string): any[] {
    try {
        const collection = MessageStore()?.getMessages?.(channelId);
        if (!collection) return [];
        if (typeof collection.toArray === "function") return collection.toArray();
        if (Array.isArray(collection._array)) return collection._array;
        if (Array.isArray(collection)) return collection;
    } catch { /* treated as an empty cache */ }
    return [];
}

/**
 * One cached message, when the client still holds it.
 *
 * getMessage is the documented accessor; the cached list is the fallback, being
 * the path already proven to work on this build. Null means "not cached", which
 * a caller must not read as "gone".
 */
export function cachedMessage(channelId: string, messageId: string): any {
    try {
        const direct = MessageStore()?.getMessage?.(channelId, messageId);
        if (direct) return direct;
    } catch { /* fall through to the cached list */ }

    return cachedMessages(channelId).find(m => String(m?.id) === String(messageId)) ?? null;
}

/**
 * Every channel in a guild, as objects carrying at least `id` and `parent_id`.
 *
 * Desktop has GuildChannelStore.getSelectableChannels; mobile has no such store,
 * and which accessor the ChannelStore exposes has changed between builds. Each
 * candidate is tried in turn and the first one that yields channels wins. The
 * caller falls back to REST when all of them come up empty.
 */
export function listGuildChannels(guildId: string): any[] {
    const store = ChannelStore() as any;
    const guildChannelStore = findByStoreName("GuildChannelStore") as any;

    const candidates: Array<() => any> = [
        () => guildChannelStore?.getChannels?.(guildId),
        () => guildChannelStore?.getSelectableChannels?.(guildId),
        () => store?.getMutableGuildChannelsForGuild?.(guildId),
        () => store?.getChannelsForGuild?.(guildId)
    ];

    for (const candidate of candidates) {
        let raw: any;
        try {
            raw = candidate();
        } catch {
            continue;
        }
        const channels = normaliseChannels(raw, guildId);
        if (channels.length) return channels;
    }

    return [];
}

/**
 * The accessors above disagree on their return type: an array of channels, an
 * array of `{ channel }` wrappers, or an id-keyed object - and getChannels also
 * buries them under SELECTABLE/VOCAL/etc. buckets. This flattens all of those.
 */
function normaliseChannels(raw: any, guildId: string): any[] {
    if (!raw) return [];

    const unwrap = (entry: any) => entry?.channel ?? entry;
    const isChannel = (c: any) => c && typeof c === "object" && c.id;

    if (Array.isArray(raw)) return raw.map(unwrap).filter(isChannel);

    const out: any[] = [];
    for (const value of Object.values(raw)) {
        if (Array.isArray(value)) out.push(...value.map(unwrap).filter(isChannel));
        else if (isChannel(unwrap(value))) out.push(unwrap(value));
    }
    // getChannels() includes an `id` string field alongside the buckets; drop
    // anything that is not actually in the guild we asked about.
    return out.filter(c => !c.guild_id || String(c.guild_id) === String(guildId));
}

/** GET /guilds/{id}/channels - the fallback when no store accessor works. */
export async function fetchGuildChannels(guildId: string): Promise<any[]> {
    const res = await RestAPI().get({ url: `/guilds/${guildId}/channels` });
    const body = res?.body;
    return Array.isArray(body) ? body : [];
}

export function sendBotMessage(channelId: string, content: string): void {
    // Kettu's own /debug command calls this with a plain string, so match that
    // rather than the object form Vencord uses.
    MessageActions()?.sendBotMessage?.(channelId, content);
}
