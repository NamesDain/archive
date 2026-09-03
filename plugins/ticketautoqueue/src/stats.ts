/*
 * TicketAutoQueue for Kettu
 * Copyright (c) 2026 river and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * Ported from the Vencord plugin of the same name.
 */

// Three horizons, because one does not answer the question on its own.
//
// Session answers "is it working right now", and is the one that matters while
// debugging. But Discord restarts often on mobile, and a session that ends every
// time the app is killed cannot describe a shift - which is what anyone actually
// wants to know. So today and lifetime are kept alongside it, and persisted.
//
// They are stored as one JSON string rather than as nested objects in the plugin
// storage. Writing into a nested object may or may not reach the backing store
// depending on how deeply the proxy wraps, and stats that silently fail to save
// would be worse than no stats at all. One string, written explicitly, cannot
// have that problem.

import { settings } from "./settings";

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

interface Persisted {
    day: string;
    today: Counters;
    lifetime: Counters;
}

export interface Counters {
    pressesSent: number;
    joinsConfirmed: number;
    rejected: number;
    wins: number;
    losses: number;
}

let stats: Stats = fresh();

/** Local date, since a shift is bounded by the operator's day, not by UTC. */
function todayKey(now = new Date()): string {
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

function emptyCounters(): Counters {
    return { pressesSent: 0, joinsConfirmed: 0, rejected: 0, wins: 0, losses: 0 };
}

function loadPersisted(): Persisted {
    let stored: any;
    try {
        stored = JSON.parse(String(settings.statsJson ?? ""));
    } catch {
        stored = null;
    }

    const day = todayKey();
    const lifetime = { ...emptyCounters(), ...(stored?.lifetime ?? {}) };

    // A stored day that is not today belongs to a shift that has ended; its
    // totals stay in lifetime and today starts again from zero.
    const today = stored?.day === day
        ? { ...emptyCounters(), ...(stored?.today ?? {}) }
        : emptyCounters();

    return { day, today, lifetime };
}

function savePersisted(p: Persisted): void {
    try {
        settings.statsJson = JSON.stringify(p);
    } catch { /* a stat that will not save must not break a press */ }
}

/** Applies a change to every persisted horizon at once. */
function bump(field: keyof Counters, by = 1): void {
    const p = loadPersisted();
    p.today[field] += by;
    p.lifetime[field] += by;
    savePersisted(p);
}

export function todayCounters(): Counters {
    return loadPersisted().today;
}

export function lifetimeCounters(): Counters {
    return loadPersisted().lifetime;
}

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
    bump("pressesSent");
    if (confirmed) {
        stats.joinsConfirmed++;
        bump("joinsConfirmed");
    }
}

export function recordRejection(): void {
    stats.rejected++;
    bump("rejected");
}

export function recordWin(): void {
    stats.wins++;
    bump("wins");
}

export function recordLoss(): void {
    stats.losses++;
    bump("losses");
}

/** Win rate over any horizon. Only decided draws count, for the same reason. */
export function rateOf(c: Counters): number | null {
    const decided = c.wins + c.losses;
    return decided === 0 ? null : c.wins / decided;
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
