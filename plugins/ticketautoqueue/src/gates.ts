/*
 * TicketAutoQueue for Kettu
 * Copyright (c) 2026 river and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * Ported from the Vencord plugin of the same name.
 */

// This is the one gate whose meaning genuinely changes on mobile.
//
// Desktop measured presence from mousemove/keydown/click plus page visibility.
// A phone has neither a pointer nor a keyboard at rest, so presence is taken from
// the two things the client can actually observe: whether Discord is the app in
// the foreground, and when you last did something in it. Both are required - the
// foreground check alone would keep claiming tickets off a phone left face-up on
// a desk, which is the exact failure the desktop idle gate existed to prevent.

import { FluxDispatcher, ReactNative } from "@vendetta/metro/common";

import { parseHourWindow, withinWindow } from "./hours";
import { settings, settingText } from "./settings";

export type GateResult = { ok: true; } | { ok: false; reason: string; };

const joined = new Set<string>();
let lastActivity = Date.now();
let lastClick = 0;
let appStateSubscription: any = null;
let onChannelSelect: (() => void) | null = null;

/** Anything that means a person is holding the phone and using Discord. */
export function noteActivity(): void {
    lastActivity = Date.now();
}

function onAppStateChange(state: string): void {
    // Only a return to the foreground counts. Going to the background is not
    // activity, and must not refresh the timestamp on the way out.
    if (state === "active") noteActivity();
}

export function startActivityTracking(): void {
    if (appStateSubscription) return;
    lastActivity = Date.now();

    const AppState = (ReactNative as any)?.AppState;
    // RN 0.65+ returns a subscription; older builds return nothing and require
    // removeEventListener. Both shapes are handled in stopActivityTracking.
    appStateSubscription = AppState?.addEventListener?.("change", onAppStateChange) ?? true;

    onChannelSelect = () => noteActivity();
    FluxDispatcher.subscribe("CHANNEL_SELECT", onChannelSelect);
}

export function stopActivityTracking(): void {
    if (!appStateSubscription) return;

    const AppState = (ReactNative as any)?.AppState;
    if (typeof appStateSubscription?.remove === "function") appStateSubscription.remove();
    else AppState?.removeEventListener?.("change", onAppStateChange);
    appStateSubscription = null;

    if (onChannelSelect) {
        FluxDispatcher.unsubscribe("CHANNEL_SELECT", onChannelSelect);
        onChannelSelect = null;
    }
}

/**
 * Deliberately self-contained rather than reading Discord's presence store:
 * account status is often pinned to Online and would not reflect real presence.
 */
export function isOperatorActive(): boolean {
    const currentState = (ReactNative as any)?.AppState?.currentState;
    // A build that exposes no AppState should not be treated as permanently away,
    // or the plugin would silently never fire; fall back to the idle timer alone.
    if (currentState && currentState !== "active") return false;
    return Date.now() - lastActivity <= settings.idleThresholdMs;
}

/** Exposed for the status command, which reports the two halves separately. */
export function isForeground(): boolean {
    const currentState = (ReactNative as any)?.AppState?.currentState;
    return !currentState || currentState === "active";
}

/** The configured window, or null when unset or unparseable - both mean no restriction. */
export function hourWindow() {
    return parseHourWindow(settingText(settings.activeHours));
}

export function withinActiveHours(at: Date = new Date()): boolean {
    return withinWindow(hourWindow(), at);
}

export function allow(channelId: string): GateResult {
    if (!settings.armed) return { ok: false, reason: "plugin is disarmed" };
    if (!withinActiveHours()) {
        return { ok: false, reason: `outside active hours (${settings.activeHours})` };
    }
    if (joined.has(channelId)) return { ok: false, reason: "already joined this ticket" };

    const sinceClick = Date.now() - lastClick;
    if (sinceClick < settings.cooldownMs) {
        return { ok: false, reason: `cooldown, ${settings.cooldownMs - sinceClick}ms remaining` };
    }

    if (settings.onlyWhenActive && !isOperatorActive()) {
        return { ok: false, reason: isForeground() ? "you are idle (idle gate)" : "Discord is backgrounded" };
    }

    return { ok: true };
}

/**
 * Claims the channel synchronously, before the press is awaited. MESSAGE_CREATE and
 * MESSAGE_UPDATE both deliver the same panel, so releasing the slot only after the
 * network call resolves leaves a window where both pass the gate and press twice.
 */
export function reserve(channelId: string): void {
    joined.add(channelId);
    lastClick = Date.now();
}

/** Hands the slot back after a failed press. The cooldown deliberately stays, to avoid hammering. */
export function release(channelId: string): void {
    joined.delete(channelId);
}

export function resetGates(): void {
    joined.clear();
    lastClick = 0;
}

export function gateStatus() {
    return {
        armed: settings.armed,
        active: isOperatorActive(),
        foreground: isForeground(),
        idleForMs: Date.now() - lastActivity,
        joinedCount: joined.size,
        hoursConfigured: hourWindow() !== null,
        withinHours: withinActiveHours()
    };
}
