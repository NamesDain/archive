/*
 * TicketAutoQueue for Kettu
 * Copyright (c) 2026 river and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * Ported from the Vencord plugin of the same name.
 */

// This module deliberately has ZERO imports, relative ones included. Node runs it
// directly for tests and can resolve neither Vencord's "@utils/*" aliases nor
// extensionless relative specifiers, so configuration arrives as parameters.

const BUTTON = 2;
const TEXT_DISPLAY = 10;
const LEAVE_PREFIX = "leave_claim_queue";
const MENTION_RE = /<@!?(\d+)>/g;
const DEADLINE_RE = /<t:(\d+):[A-Za-z]>/;
// Observed live: "👍 Selected staff: <@id>" under a "Claim Queue Winner" heading.
// Kept as the default, but the caller may supply its own: the entire win path
// hangs off this one phrase, so a bot rewording its announcement would otherwise
// make every win undetectable until the plugin itself was changed.
const WINNER_RE = /selected staff:?\s*<@!?(\d+)>/i;
const GRACE_MS = 60000;

export interface PendingDraw {
    channelId: string;
    channelName: string;
    panelMessageId: string | null;
    /** When the draw actually closes, from the panel countdown. Null until a panel is seen. */
    drawsAt: number | null;
    expiresAt: number;
    alerted: boolean;
}

export type DrawOutcome =
    | { kind: "panel"; }
    | { kind: "won"; draw: PendingDraw; }
    | { kind: "lost"; draw: PendingDraw; winnerId: string; }
    /** A bot message during a live draw that matched no known shape. Logged as evidence. */
    | { kind: "unknown"; draw: PendingDraw; }
    | { kind: "ignore"; };

const pending = new Map<string, PendingDraw>();

function visitNodes(components: unknown, fn: (node: any) => void): void {
    const seen = new Set<any>();
    const visit = (nodes: unknown) => {
        if (!Array.isArray(nodes)) return;
        for (const node of nodes) {
            if (!node || typeof node !== "object" || seen.has(node)) continue;
            seen.add(node);
            const n = node as any;
            fn(n);
            if (Array.isArray(n.components)) visit(n.components);
            if (n.accessory) visit([n.accessory]);
        }
    };
    visit(components);
}

export function collectTexts(components: unknown): string[] {
    const out: string[] = [];
    visitNodes(components, n => {
        if (n.type === TEXT_DISPLAY && typeof n.content === "string") out.push(n.content);
    });
    return out;
}

/**
 * The mobile client stores this key as `customId`, while raw gateway and REST
 * payloads use `custom_id`. Reading only one spelling made every live panel look
 * like it had no Leave button, which is how a draw stayed invisible.
 */
function customIdOf(node: any): string {
    const id = node?.custom_id ?? node?.customId;
    return typeof id === "string" ? id : "";
}

/** A leave_claim_queue button can only exist while the draw is still open. */
export function hasLeaveButton(components: unknown): boolean {
    let found = false;
    visitNodes(components, n => {
        if (n.type === BUTTON && customIdOf(n).startsWith(LEAVE_PREFIX)) found = true;
    });
    return found;
}

/**
 * The store record types `mentions` as string[] while raw gateway JSON types it as
 * UserJSON[]; MESSAGE_UPDATE delivers the former and MESSAGE_CREATE the latter, so
 * reading one shape fails silently on half the events. Components V2 also nests text
 * outside `content`, and whether that populates `mentions` is unverified, so raw
 * <@id> is scanned too. A missed mention is a missed win.
 */
export function mentionIds(message: any): Set<string> {
    const out = new Set<string>();
    for (const m of message?.mentions ?? []) {
        const id = typeof m === "string" ? m : m?.id;
        if (id) out.add(String(id));
    }
    for (const text of [String(message?.content ?? ""), ...collectTexts(message?.components)]) {
        for (const match of text.matchAll(MENTION_RE)) out.add(match[1]);
    }
    return out;
}

/**
 * The ID the winner announcement names, or null if this is not an announcement.
 *
 * This must read the *announcement line* rather than the message's mention set. When
 * the draw closes, the queue panel drops its Leave button but keeps listing everyone
 * who joined - so "mentions me" is true for every loser, and using it declared a win
 * for all of them.
 */
export function winnerId(texts: string[], pattern: RegExp = WINNER_RE): string | null {
    for (const text of texts) {
        const m = pattern.exec(text);
        // A pattern with no capture group matches the announcement but names
        // nobody, which would read as a win for whoever saw it first.
        if (m && m[1]) return m[1];
    }
    return null;
}

/** Reads the panel's "selection ends <t:...:R>" stamp. Discord emits seconds. */
export function parseDeadline(texts: string[]): number | null {
    for (const text of texts) {
        const m = DEADLINE_RE.exec(text);
        if (m) return Number(m[1]) * 1000;
    }
    return null;
}

/**
 * True when a message carries a countdown stamp that has already elapsed.
 *
 * Used by the sweep to leave alone a ticket whose draw closed while we were offline.
 * Absence of a stamp is not evidence that a draw is live, so this returns false and
 * lets the caller proceed - refusing to press whenever we cannot prove a draw is open
 * would disable the sweep entirely on any panel that carries no timer.
 */
export function deadlinePassed(message: any, now = Date.now()): boolean {
    const texts = [String(message?.content ?? ""), ...collectTexts(message?.components)];
    const deadline = parseDeadline(texts);
    return deadline !== null && deadline <= now;
}

export function trackDraw(channelId: string, channelName: string, windowMs: number, now = Date.now()): void {
    pending.set(channelId, {
        channelId,
        channelName,
        panelMessageId: null,
        drawsAt: null,
        expiresAt: now + windowMs,
        alerted: false
    });
}

export function pendingDraws(now = Date.now()): PendingDraw[] {
    const out: PendingDraw[] = [];
    for (const draw of [...pending.values()]) {
        if (draw.expiresAt > now) out.push(draw);
        else pending.delete(draw.channelId);
    }
    return out;
}

export function clearDraws(): void {
    pending.clear();
}

/**
 * Draws about to close that have not been checked yet. `drawsAt` is null until a panel
 * carrying a countdown has been seen, and a draw whose deadline has already passed is
 * excluded: warning someone after the fact is noise, and the win path already covers it.
 */
export function drawsNeedingAlert(leadMs: number, now = Date.now()): PendingDraw[] {
    return pendingDraws(now).filter(d =>
        !d.alerted && d.drawsAt !== null && d.drawsAt > now && d.drawsAt - now <= leadMs);
}

/** Marks the one-shot check as spent, whether or not it produced a warning. */
export function markAlerted(channelId: string): void {
    const draw = pending.get(channelId);
    if (draw) draw.alerted = true;
}

export function observeDraw(
    message: any,
    selfId: string,
    ticketBotId: string,
    now = Date.now(),
    winnerPattern?: RegExp
): DrawOutcome {
    const channelId = String(message?.channel_id ?? "");
    const draw = pending.get(channelId);
    if (!draw) return { kind: "ignore" };

    if (draw.expiresAt <= now) {
        pending.delete(channelId);
        return { kind: "ignore" };
    }

    const authorId = message?.author?.id ? String(message.author.id) : "";
    if (ticketBotId && authorId !== ticketBotId) return { kind: "ignore" };

    // Rule 1: the panel is live. It lists us in its waiting list, so treating a
    // mention here as a win would self-trigger the instant we join.
    if (hasLeaveButton(message?.components)) {
        draw.panelMessageId = String(message?.id ?? "");
        const deadline = parseDeadline(collectTexts(message?.components));
        if (deadline) {
            draw.drawsAt = deadline;
            draw.expiresAt = deadline + GRACE_MS;
        }
        return { kind: "panel" };
    }

    // Rule 2: the bot names the winner explicitly, in its own message. Anything else -
    // including the closed roster that still lists us - is not a result.
    const texts = [String(message?.content ?? ""), ...collectTexts(message?.components)];
    const winner = winnerId(texts, winnerPattern ?? WINNER_RE);
    if (winner === null) return { kind: "unknown", draw };

    pending.delete(channelId);
    return winner === selfId
        ? { kind: "won", draw }
        : { kind: "lost", draw, winnerId: winner };
}
