/*
 * TicketAutoQueue for Kettu
 * Copyright (c) 2026 river and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * Ported from the Vencord plugin of the same name.
 */

// Zero imports, relative ones included, so Node can run this directly under test.

const HHMM = /^(\d{1,2}):(\d{2})$/;

/** Minutes since local midnight. A window may wrap past midnight, so end may be < start. */
export interface HourWindow {
    startMin: number;
    endMin: number;
}

function toMinutes(text: string): number | null {
    const m = HHMM.exec(text.trim());
    if (!m) return null;
    const hours = Number(m[1]);
    const mins = Number(m[2]);
    if (hours > 23 || mins > 59) return null;
    return hours * 60 + mins;
}

/**
 * Parses "HH:MM-HH:MM" in local time. Returns null for anything unparseable, which
 * every caller treats as "no restriction" - a typo must not silently stop the plugin
 * joining anything, because that failure is invisible until a ticket is already lost.
 */
export function parseHourWindow(raw: string): HourWindow | null {
    const parts = (raw ?? "").split("-");
    if (parts.length !== 2) return null;

    const startMin = toMinutes(parts[0]);
    const endMin = toMinutes(parts[1]);
    if (startMin === null || endMin === null) return null;

    return { startMin, endMin };
}

/**
 * Whether a moment falls inside the window.
 *
 * An end before the start means the window wraps midnight, which is the common case
 * here: "20:00-04:00" is an evening shift, not a mistake. Equal bounds mean the whole
 * day, again so that a fat-fingered setting fails open rather than muting the plugin.
 */
export function withinWindow(window: HourWindow | null, at: Date = new Date()): boolean {
    if (window === null) return true;

    const { startMin, endMin } = window;
    if (startMin === endMin) return true;

    const minute = at.getHours() * 60 + at.getMinutes();
    return startMin < endMin
        ? minute >= startMin && minute < endMin
        : minute >= startMin || minute < endMin;
}
