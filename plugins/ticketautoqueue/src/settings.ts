/*
 * TicketAutoQueue for Kettu
 * Copyright (c) 2026 river and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * Ported from the Vencord plugin of the same name.
 */

// Vencord's definePluginSettings both stores the values and renders the settings
// UI from the same declaration. Vendetta splits those: this file owns the values
// and their defaults, Settings.tsx owns the UI.

import { storage } from "@vendetta/plugin";

const SNOWFLAKE = /^\d{17,20}$/;

export interface TaqSettings {
    armed: boolean;
    categoryIds: string;
    buttonLabels: string;
    ticketBotId: string;
    channelNamePattern: string;
    onlyWhenActive: boolean;
    idleThresholdMs: number;
    activeHours: string;
    minDelayMs: number;
    maxDelayMs: number;
    cooldownMs: number;
    catchUpOnStart: boolean;
    periodicSweepMs: number;
    sweepOnReconnect: boolean;
    catchUpMaxAgeMs: number;
    notifyOnWin: boolean;
    autoNavigateOnWin: boolean;
    warnIfAwayOnDraw: boolean;
    drawWarningLeadMs: number;
    drawWatchWindowMs: number;
    notifyOnJoin: boolean;
    verboseLogging: boolean;
}

export const DEFAULTS: Readonly<TaqSettings> = {
    armed: true,
    categoryIds: "",
    buttonLabels: "Join Queue",
    ticketBotId: "",
    channelNamePattern: "",
    onlyWhenActive: true,
    // Five minutes of no interaction. On mobile this is measured from the last
    // foreground/navigation/send rather than from mouse and keyboard input.
    idleThresholdMs: 300000,
    activeHours: "",
    minDelayMs: 300,
    maxDelayMs: 800,
    cooldownMs: 3000,
    catchUpOnStart: false,
    periodicSweepMs: 0,
    sweepOnReconnect: true,
    catchUpMaxAgeMs: 3600000,
    notifyOnWin: true,
    autoNavigateOnWin: true,
    warnIfAwayOnDraw: true,
    drawWarningLeadMs: 10000,
    drawWatchWindowMs: 600000,
    notifyOnJoin: true,
    verboseLogging: false
};

export const settings = storage as unknown as TaqSettings;

/**
 * Fills in missing keys, and repairs ones holding the wrong type.
 *
 * The repair is not defensive padding. An earlier build of the settings page
 * wired Discord's form input straight to storage, and that control reports its
 * value as `{ text }` rather than a string on this platform - so `categoryIds`
 * could be saved as an object. Every gate then read it as unconfigured and the
 * plugin sat inert with nothing in the log to say why. Anyone upgrading past
 * that build still has the bad value, and a missing-key check alone would leave
 * it in place forever, so the text is recovered where possible and the key is
 * reset where not.
 *
 * Runs on load rather than at import time: Kettu creates the storage proxy before
 * it evaluates the plugin, but writing to it during module evaluation would land
 * before the plugin object exists.
 */
export function initSettings(): void {
    for (const [key, fallback] of Object.entries(DEFAULTS)) {
        const current = (settings as any)[key];

        if (current === undefined) {
            (settings as any)[key] = fallback;
            continue;
        }

        if (typeof current === typeof fallback) continue;

        // Salvage the value the user actually typed before falling back.
        const recovered = typeof fallback === "string" && current && typeof current === "object"
            ? (current as any).text
            : undefined;

        (settings as any)[key] = typeof recovered === "string" ? recovered : fallback;
    }
}

/** Anything reaching the parsers may still be a stray shape from an older build. */
export const settingText = (raw: unknown): string => {
    if (typeof raw === "string") return raw;
    if (raw && typeof raw === "object" && typeof (raw as any).text === "string") return (raw as any).text;
    return "";
};

/** Split a comma-separated string into a set of valid snowflake IDs. Invalid entries are dropped, never thrown. */
export function parseIdList(raw: string): Set<string> {
    const out = new Set<string>();
    for (const part of settingText(raw).split(",")) {
        const id = part.trim();
        if (SNOWFLAKE.test(id)) out.add(id);
    }
    return out;
}

/** Split a comma-separated string into lowercased, trimmed labels. */
export function parseLabelList(raw: string): string[] {
    return settingText(raw)
        .split(",")
        .map(s => s.trim().toLowerCase())
        .filter(Boolean);
}

/** Compile a user-supplied regex. Invalid input disables the filter rather than breaking every message. */
export function parsePattern(raw: string): RegExp | null {
    const src = settingText(raw).trim();
    if (!src) return null;
    try {
        return new RegExp(src, "i");
    } catch {
        return null;
    }
}

/** The configured ticket bot ID, tolerant of a value stored by an older build. */
export function ticketBotId(): string {
    return settingText(settings.ticketBotId).trim();
}

/**
 * A numeric setting coming back from the UI, which edits every field as text.
 * A half-typed or cleared box must not be persisted as NaN, because NaN compares
 * false against every threshold and would silently disable whatever gate reads it.
 */
export function parseNumber(raw: string, fallback: number): number {
    const value = Number((raw ?? "").trim());
    return Number.isFinite(value) && value >= 0 ? value : fallback;
}
