/*
 * TicketAutoQueue for Kettu
 * Copyright (c) 2026 river and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * Ported from the Vencord plugin of the same name.
 */

// Zero imports, so this stays trivially testable.
//
// A short record of what the plugin decided and why, readable from inside
// Discord. Verbose logging already explains every decision, but reading a
// console on a phone is impractical - which is why "why did it not join that
// one" has had to be answered from screenshots and guesswork so far. This puts
// the last few decisions where they can just be read.
//
// Only interesting decisions are kept. Every message in a watched category runs
// through the matcher, and recording the ones that were never ticket panels
// would bury the handful that matter.

export type Decision =
    | "matched"
    | "blocked"
    | "pressed"
    | "joined"
    | "rejected"
    | "failed"
    | "won"
    | "lost";

export interface Entry {
    at: number;
    channel: string;
    decision: Decision;
    /** Why, when the decision alone does not say it - a gate reason, mostly. */
    detail?: string;
}

// Enough to cover a busy few minutes without turning the report into a wall.
const MAX_ENTRIES = 20;

let entries: Entry[] = [];

export function record(decision: Decision, channel: string, detail?: string): void {
    entries.push({ at: Date.now(), channel, decision, detail });
    if (entries.length > MAX_ENTRIES) entries = entries.slice(-MAX_ENTRIES);
}

/** Newest first, which is the order anyone reading this wants. */
export function recent(): Entry[] {
    return [...entries].reverse();
}

export function clearHistory(): void {
    entries = [];
}

const LABELS: Record<Decision, string> = {
    matched: "found a panel",
    blocked: "did not press",
    pressed: "pressed",
    joined: "joined",
    rejected: "bot ignored it",
    failed: "press failed",
    won: "WON",
    lost: "lost"
};

export function describe(entry: Entry, now = Date.now()): string {
    const ago = Math.max(0, Math.round((now - entry.at) / 1000));
    const when = ago < 60 ? `${ago}s` : `${Math.round(ago / 60)}m`;
    const why = entry.detail ? ` — ${entry.detail}` : "";
    return `\`${when} ago\` #${entry.channel}: **${LABELS[entry.decision]}**${why}`;
}
