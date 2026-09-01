/*
 * TicketAutoQueue for Kettu
 * Copyright (c) 2026 river and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * Ported from the Vencord plugin of the same name.
 */

// The desktop plugin had two notification tiers: a toast for routine events and a
// permanent, clickable desktop notification for the two that matter (you won the
// draw; a draw is closing while you are away). Mobile has no desktop notification
// API from inside the client, so the second tier becomes a modal alert - which is
// likewise dismissed by hand and can carry the "jump to the ticket" action.

import { findByProps } from "@vendetta/metro";
import { FluxDispatcher, ReactNative } from "@vendetta/metro/common";
import { showConfirmationAlert } from "@vendetta/ui/alerts";
import { getAssetIDByName } from "@vendetta/ui/assets";
import { showToast } from "@vendetta/ui/toasts";

import { settings } from "./settings";

/** Asset names differ between Discord builds; the first that resolves is used. */
function assetId(...names: string[]): number | undefined {
    for (const name of names) {
        try {
            const id = getAssetIDByName(name);
            if (id) return id;
        } catch { /* try the next name */ }
    }
    return undefined;
}

export function toastSuccess(message: string): void {
    if (!settings.notifyOnJoin) return;
    showToast(message, assetId("Check", "ic_check_24px", "check"));
}

export function toastFailure(message: string): void {
    if (!settings.notifyOnJoin) return;
    showToast(message, assetId("Small", "ic_close_16px", "close"));
}

/** Unconditional: used for command output, which the user explicitly asked for. */
export function toast(message: string): void {
    showToast(message, assetId("Check", "ic_check_24px", "check"));
}

/**
 * Opens a channel.
 *
 * Vencord has ChannelRouter.transitionToChannel. Mobile's equivalent module is
 * keyed by guild and has changed shape, so the CHANNEL_SELECT dispatch - which is
 * what every navigation path ends up firing anyway - is the fallback.
 */
export function openChannel(guildId: string | undefined, channelId: string): void {
    try {
        const router = findByProps("transitionToGuild") as any;
        if (typeof router?.transitionToGuild === "function" && guildId) {
            router.transitionToGuild(guildId, channelId);
            return;
        }
    } catch { /* fall through to the dispatch */ }

    try {
        FluxDispatcher.dispatch({
            type: "CHANNEL_SELECT",
            guildId: guildId ?? null,
            channelId
        });
    } catch { /* navigation is a convenience; never let it break the caller */ }
}

/**
 * The mobile stand-in for a permanent desktop notification: a modal that stays up
 * until dismissed, with the jump-to-channel action on its confirm button.
 */
export function alertWithJump(
    title: string,
    content: string,
    guildId: string | undefined,
    channelId: string
): void {
    try {
        ReactNative?.Vibration?.vibrate?.(400);
    } catch { /* a device that cannot vibrate still gets the modal */ }

    showConfirmationAlert({
        title,
        content,
        confirmText: "Open ticket",
        cancelText: "Dismiss",
        onConfirm: () => openChannel(guildId, channelId)
    });
}
