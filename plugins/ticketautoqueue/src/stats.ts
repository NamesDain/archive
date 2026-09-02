/*
 * TicketAutoQueue for Kettu
 * Copyright (c) 2026 river and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * Ported from the Vencord plugin of the same name.
 */

// Zero imports, so this stays trivially testable and cannot pull the plugin's
// state into a cycle.
//
// Counters are per session on purpose. The question they answer is "is this
// working for me right now" - after a restart the answer is about a new session,
// and a persisted lifetime total would bury a run where nothing is landing.

export interface Stats {
    /** Presses Discord accepted for delivery, whether or not the bot then acted. */
    pressesSent: number;
    /** Presses the client confirmed the bot acted on. */
    joinsConfirmed: number;
    /** Tickets abandoned because the bot ignored every attempt. */
    rejected: number;
    /** Draws that picked you. */
    wins: number;
    /** Draws that picked somebody else. */
    losses: number;
    startedAt: number;
}

let stats: Stats = fresh();

function fresh(): Stats {
    return {
        pressesSent: 0,
        joinsConfirmed: 0,
        rejected: 0,
        wins: 0,
        losses: 0,
        startedAt: Date.now()
    };
}

export function resetStats(): void {
    stats = fresh();
}

export function recordPress(confirmed: boolean): void {
    stats.pressesSent++;
    if (confirmed) stats.joinsConfirmed++;
}

export function recordRejection(): void {
    stats.rejected++;
}

export function recordWin(): void {
    stats.wins++;
}

export function recordLoss(): void {
    stats.losses++;
}

export function getStats(): Readonly<Stats> {
    return stats;
}

/**
 * Wins as a share of decided draws.
 *
 * Only draws that actually resolved count. Including the ones still open, or the
 * ones whose result was never seen, would report a falling win rate that only
 * means results are pending.
 */
export function winRate(): number | null {
    const decided = stats.wins + stats.losses;
    return decided === 0 ? null : stats.wins / decided;
}

export function describeDuration(ms: number): string {
    if (ms < 1000) return "just now";
    const seconds = Math.round(ms / 1000);
    if (seconds < 60) return `${seconds}s`;
    const minutes = Math.round(seconds / 60);
    if (minutes < 60) return `${minutes} min`;
    const hours = minutes / 60;
    return `${Number.isInteger(hours) ? hours : hours.toFixed(1)} h`;
}

/**
 * Parses a pause duration: "30m", "2h", "90s", or a bare number of minutes.
 * Returns null for anything unparseable, so the caller can say so rather than
 * silently pausing for a length nobody asked for.
 */
export function parseDuration(raw: string): number | null {
    const text = (raw ?? "").trim().toLowerCase();
    if (!text) return null;

    const match = /^(\d+(?:\.\d+)?)\s*(s|sec|secs|m|min|mins|h|hr|hrs)?$/.exec(text);
    if (!match) return null;

    const amount = Number(match[1]);
    if (!Number.isFinite(amount) || amount <= 0) return null;

    const unit = match[2] ?? "m";
    const scale = unit.startsWith("s") ? 1000 : unit.startsWith("h") ? 3600000 : 60000;
    return Math.round(amount * scale);
}
