/*
 * TicketAutoQueue for Kettu
 * Copyright (c) 2026 river and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * Ported from the Vencord plugin of the same name.
 */

import { logger } from "@vendetta";
import { registerCommand } from "@vendetta/commands";
import { FluxDispatcher } from "@vendetta/metro/common";

import { press } from "./clicker";
import { cachedMessages, getChannel, getCurrentUserId, MessageStore, sendBotMessage } from "./discord";
import { clearDraws, drawsNeedingAlert, markAlerted, observeDraw, pendingDraws, trackDraw } from "./draws";
import {
    allow, gateStatus, isOperatorActive, noteActivity, noteRejection, rejectionCount, release,
    reserve, resetGates, startActivityTracking, stopActivityTracking, withinActiveHours
} from "./gates";
import { outcomeReportingSeen, resetInteractionWatch, startInteractionWatch, stopInteractionWatch } from "./interactions";
import { collectButtons, customIdOf, matchTicket } from "./matcher";
import { forgetSessionId, rememberSessionId, sessionStatus } from "./session";
import { initSettings, parseIdList, parseLabelList, settings, ticketBotId } from "./settings";
import Settings from "./Settings";
import { isSweeping, sweepOpenTickets } from "./sweep";
import { clearUnreachable, unreachableCount } from "./unreachable";
import { alertWithJump, openChannel, toast, toastFailure, toastSuccess } from "./ui";

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

const OPTION_TYPE_STRING = 3;

let startSweepTimer: ReturnType<typeof setTimeout> | null = null;
let reconnectSweepTimer: ReturnType<typeof setTimeout> | null = null;
let awayCheckTimer: ReturnType<typeof setInterval> | null = null;
let unregisterCommand: (() => void) | null = null;
let lastAutoSweepAt = 0;
// Cleared whenever the app wakes - a reconnect or a return to the foreground -
// so that wake is allowed one sweep regardless of how recently one ran.
let sweptSinceWake = true;
let foregroundSweepTimer: ReturnType<typeof setTimeout> | null = null;

// Guild channels and the message store fill in asynchronously after a connection
// opens, so an immediate sweep would see a partial channel list.
//
// A cold start can afford to wait for that. A wake cannot: the app was suspended,
// the draw on anything opened meanwhile closes in about a minute, and waiting a
// quarter of that window before looking is how a ticket gets joined late or not
// at all. The sweep no longer depends on a warm store anyway - it lists channels
// from REST when the store has none, and hands each record to the matcher - so
// the wake path only pauses long enough for the reconnect to settle.
const STORE_SETTLE_MS = 15000;
const WAKE_SETTLE_MS = 3000;

// One floor for every automatic trigger. Startup, reconnect and the periodic tick can
// all come due at once - on a fresh launch they always do - and this collapses them
// into a single scan instead of three overlapping ones.
const AUTO_SWEEP_MIN_GAP_MS = 60000;

// Polled rather than one timer per draw: a draw's deadline is only learned when its
// panel arrives, and it can be revised by a later edit, so a scheduled timer would
// need cancelling and rescheduling. A 5s poll is free by comparison.
const AWAY_CHECK_INTERVAL_MS = 5000;

function randomDelay(): number {
    const min = Math.max(0, settings.minDelayMs);
    const max = Math.max(min, settings.maxDelayMs);
    return min + Math.floor(Math.random() * (max - min + 1));
}

/** The guild a tracked draw belongs to, resolved late because PendingDraw does not carry it. */
function guildOf(channelId: string): string | undefined {
    const guildId = getChannel(channelId)?.guild_id;
    return guildId ? String(guildId) : undefined;
}

async function handleMessage(message: any, source: string, retriesLeft = 2) {
    const match = matchTicket(message);
    if (!match.ok) {
        // Ticket channels are created milliseconds before the panel is posted, so
        // MESSAGE_CREATE can beat CHANNEL_CREATE into the store. Give it a moment.
        if (match.reason === "channel not in store" && retriesLeft > 0) {
            await sleep(1500);
            return handleMessage(message, source, retriesLeft - 1);
        }
        if (settings.verboseLogging) logger.info(`[${source}] skip: ${match.reason}`);
        return;
    }

    const { target } = match;
    if (settings.verboseLogging) logger.info(`[${source}] matched "${target.label}" in #${target.channelName}`);

    const gate = allow(target.channelId);
    if (!gate.ok) {
        if (settings.verboseLogging) logger.info(`gate blocked #${target.channelName}: ${gate.reason}`);
        return;
    }

    await sleep(randomDelay());

    // Re-check: state may have changed during the delay.
    const recheck = allow(target.channelId);
    if (!recheck.ok) {
        if (settings.verboseLogging) logger.info(`gate blocked after delay #${target.channelName}: ${recheck.reason}`);
        return;
    }

    reserve(target.channelId);

    const result = await press(target);

    if (result === "rejected") {
        // The bot took the interaction and did nothing with it - the same failure a
        // manual tap hits on these tickets. Hand the slot back so a later panel edit
        // can try again, but count it: the gate stops after a couple of rounds so one
        // broken ticket cannot keep firing interactions for as long as it stays open.
        release(target.channelId);
        const rounds = noteRejection(target.channelId);
        logger.error(`The bot ignored every press in #${target.channelName} (round ${rounds})`);
        toastFailure(`Bot did not respond: #${target.channelName}`);
        return;
    }

    if (result !== "joined" && result !== "sent") {
        release(target.channelId);
        logger.error(`Failed to press "${target.label}" in #${target.channelName} (${result})`);
        toastFailure(`TicketAutoQueue: failed on #${target.channelName}`);
        return;
    }

    trackDraw(target.channelId, target.channelName, settings.drawWatchWindowMs);
    toastSuccess(result === "joined"
        ? `Joined queue: #${target.channelName}`
        : `Pressed Join Queue: #${target.channelName}`);
}

function handleDraw(message: any, source: string) {
    const selfId = getCurrentUserId();
    if (!selfId) return;

    const outcome = observeDraw(message, selfId, ticketBotId());

    if (outcome.kind === "lost") {
        logger.info(`[${source}] draw on #${outcome.draw.channelName} went to ${outcome.winnerId}`);
        return;
    }

    // A bot message during a live draw in a shape we do not recognise. Dumped because
    // the winner announcement format is the one thing that decides this feature, and a
    // silent miss here is a missed win.
    if (outcome.kind === "unknown") {
        logger.info(`[${source}] unrecognised message during draw on #${outcome.draw.channelName}: ${JSON.stringify(message?.components)}`);
        return;
    }

    if (outcome.kind !== "won") return;

    const { draw } = outcome;

    logger.info(`[${source}] WON #${draw.channelName} - deciding message: ${JSON.stringify(message?.components)}`);

    if (settings.notifyOnWin) {
        alertWithJump(
            "Ticket assigned to you",
            `You were selected for #${draw.channelName}`,
            guildOf(draw.channelId),
            draw.channelId
        );
    }

    if (settings.autoNavigateOnWin) openChannel(guildOf(draw.channelId), draw.channelId);
}

/**
 * The join-time idle gate cannot cover this: it runs when the panel appears, but the
 * draw resolves up to a minute later, so an operator can join and then put the phone
 * down. This warns rather than leaving the queue - a wrong auto-leave forfeits a ticket
 * the operator wanted, while a wrong warning costs one alert.
 */
function checkAwayDuringDraws() {
    if (!settings.warnIfAwayOnDraw) return;

    for (const draw of drawsNeedingAlert(settings.drawWarningLeadMs)) {
        // Spend the one-shot regardless of the outcome, so a draw cannot warn twice.
        markAlerted(draw.channelId);
        if (isOperatorActive()) continue;

        logger.info(`Away with a draw closing on #${draw.channelName}`);
        alertWithJump(
            "Draw closing and you are away",
            `#${draw.channelName} is about to pick a staff member. You are still in the queue.`,
            guildOf(draw.channelId),
            draw.channelId
        );
    }
}

/**
 * The gateway only delivers messages while it is connected, so a ticket opened during a
 * reconnect, an app restart, or a network drop produces no event and would never be seen.
 * A re-scan is the only way to find those - and on mobile the gateway also drops every
 * time the OS suspends the app, so this runs far more often than it did on desktop.
 */
async function autoSweep(reason: string) {
    if (!settings.armed || isSweeping()) return;

    // Bailing here rather than letting every channel fail its own gate: outside the
    // window the whole pass is pointless, and it would still cost a fetch per channel.
    if (!withinActiveHours()) {
        if (settings.verboseLogging) logger.info(`[${reason}] sweep skipped: outside active hours`);
        return;
    }

    // Checked before the gap timestamp is taken, so a sweep declined for being away is
    // retried on the next tick rather than pushed a full interval into the future.
    if (settings.onlyWhenActive && !isOperatorActive()) {
        if (settings.verboseLogging) logger.info(`[${reason}] sweep skipped: you are away`);
        return;
    }

    // The gap floor collapses startup, reconnect and the periodic tick when they
    // all come due at once. It must not also swallow the one sweep that follows
    // waking up: on mobile the gateway drops on every app switch, so a recent
    // sweep from the previous wake would suppress exactly the scan that matters.
    // One sweep per wake is let through; everything after it obeys the floor.
    const withinGap = Date.now() - lastAutoSweepAt < AUTO_SWEEP_MIN_GAP_MS;
    if (withinGap && sweptSinceWake) return;

    sweptSinceWake = true;
    lastAutoSweepAt = Date.now();

    try {
        const s = await sweepOpenTickets();
        // Silent when it finds nothing, which is the normal case; a line per idle scan
        // would bury the ones that matter.
        if (s.joined || s.failed || settings.verboseLogging) {
            logger.info(`[${reason}] sweep: joined ${s.joined}, failed ${s.failed}, skipped ${s.skipped} of ${s.candidates}.`);
        }
    } catch (err) {
        logger.error(`[${reason}] sweep failed:`, err);
    }
}

function maybePeriodicSweep() {
    const period = settings.periodicSweepMs;
    if (period <= 0) return;
    if (Date.now() - lastAutoSweepAt < Math.max(AUTO_SWEEP_MIN_GAP_MS, period)) return;
    void autoSweep("periodic");
}

// An exception escaping a flux handler breaks the dispatcher for every other plugin.
function onMessageCreate(event: any) {
    try {
        if (event?.optimistic) {
            // Our own outgoing message: not a ticket panel, but proof someone is here.
            noteActivity();
            return;
        }
        if (event?.message?.author?.id && String(event.message.author.id) === getCurrentUserId()) {
            noteActivity();
        }
        handleDraw(event?.message, "CREATE");
        void handleMessage(event?.message, "CREATE");
    } catch (err) {
        logger.error("MESSAGE_CREATE handler threw:", err);
    }
}

// The ticket panel is edited across its lifecycle, so Join Queue can arrive
// on an edit rather than the original post. Gateway edits are partial, so
// resolve the merged record from the store before matching.
function onMessageUpdate(event: any) {
    try {
        const partial = event?.message;
        if (!partial?.id || !partial?.channel_id) return;
        const full = findMessage(partial.channel_id, partial.id) ?? partial;
        handleDraw(full, "UPDATE");
        void handleMessage(full, "UPDATE");
    } catch (err) {
        logger.error("MESSAGE_UPDATE handler threw:", err);
    }
}

function findMessage(channelId: string, messageId: string): any {
    try {
        return MessageStore()?.getMessage?.(channelId, messageId);
    } catch {
        return null;
    }
}

// Fires on the initial connect as well as on every resume. The shared gap floor
// in autoSweep is what stops that first one duplicating the startup sweep.
function onConnectionOpen(event: any) {
    try {
        // Do this before the sweepOnReconnect check: the session id is needed to press
        // anything at all, whether or not this connect triggers a sweep.
        rememberSessionId(event);

        if (!settings.sweepOnReconnect) return;
        if (reconnectSweepTimer !== null) clearTimeout(reconnectSweepTimer);
        sweptSinceWake = false;
        reconnectSweepTimer = setTimeout(() => void autoSweep("reconnect"), WAKE_SETTLE_MS);
    } catch (err) {
        logger.error("CONNECTION_OPEN handler threw:", err);
    }
}

/**
 * Returning to the app is the other half of the wake path. The gateway does not
 * always drop on a short backgrounding, so waiting for CONNECTION_OPEN alone can
 * mean nothing ever re-scans - which shows up as a ticket that was never joined
 * even though the app was open again well before its draw closed.
 */
function onReturnedToForeground(): void {
    try {
        if (!settings.sweepOnReconnect) return;
        sweptSinceWake = false;
        if (foregroundSweepTimer !== null) clearTimeout(foregroundSweepTimer);
        foregroundSweepTimer = setTimeout(() => void autoSweep("foreground"), WAKE_SETTLE_MS);
    } catch (err) {
        logger.error("Foreground handler threw:", err);
    }
}

function optionValue(args: any[], name: string, fallback: string): string {
    const found = (args ?? []).find((a: any) => a?.name === name);
    const value = found?.value;
    return value === undefined || value === null || value === "" ? fallback : String(value);
}

function statusReport(): string {
    const gates = gateStatus();
    const categories = [...parseIdList(settings.categoryIds)];
    const lines = [
        `**Armed:** ${gates.armed}`,
        `**Categories:** ${categories.length ? categories.join(", ") : "_none configured_"}`,
        `**Labels:** ${parseLabelList(settings.buttonLabels).join(", ") || "_none_"}`,
        `**Ticket bot:** ${ticketBotId() || "_any author (not recommended)_"}`,
        `**Name pattern:** ${settings.channelNamePattern || "_none_"}`,
        `**Presence gate:** ${settings.onlyWhenActive ? "on" : "off"} - app is ${gates.foreground ? "in the foreground" : "BACKGROUNDED"}, last used ${Math.round(gates.idleForMs / 1000)}s ago (${gates.active ? "active" : "AWAY"})`,
        `**Active hours:** ${gates.hoursConfigured ? `${settings.activeHours} - currently ${gates.withinHours ? "inside" : "OUTSIDE (not joining)"}` : "_any time_"}`,
        `**Queues joined this session:** ${gates.joinedCount} _(presses sent, not wins)_`
    ];

    // A press needs this, and Discord will accept an interaction carrying a stale
    // one and then never route the bot's reply back - which surfaces only as
    // "This interaction failed" on the panel, with nothing logged here.
    const session = sessionStatus();
    lines.push(`**Gateway session:** ${session.held ? `held via ${session.source} — ${session.hint}` : "**NONE — presses cannot work**"}`);

    const period = settings.periodicSweepMs;
    const sinceSweep = lastAutoSweepAt ? `${Math.round((Date.now() - lastAutoSweepAt) / 1000)}s ago` : "never";
    lines.push(`**Auto sweep:** ${period > 0 ? `every ${Math.round(Math.max(AUTO_SWEEP_MIN_GAP_MS, period) / 1000)}s` : "off"}, on reconnect ${settings.sweepOnReconnect ? "on" : "off"} - last ran ${sinceSweep}`);

    lines.push(`**Press confirmation:** ${outcomeReportingSeen()
        ? "on — a join is only reported once the client confirms it"
        : "_not seen yet on this build; presses report as sent, not joined_"}`);

    const givenUp = rejectionCount();
    if (givenUp > 0) lines.push(`**Given up on:** ${givenUp} ticket(s) the bot would not accept`);

    const unreadable = unreachableCount();
    if (unreadable > 0) lines.push(`**Unreadable channels:** ${unreadable} _(cached, not retried this hour)_`);

    const draws = pendingDraws();
    lines.push(draws.length
        ? `**Pending draws:** ${draws.map(d => `#${d.channelName} (${Math.max(0, Math.round((d.expiresAt - Date.now()) / 1000))}s left)`).join(", ")}`
        : "**Pending draws:** _none_");

    return lines.join("\n");
}

function testReport(channelId: string): string {
    const channel = getChannel(channelId);
    const watched = parseIdList(settings.categoryIds);
    const lines = [
        `**Channel:** #${channel?.name ?? "unknown"}`,
        `**parent_id:** \`${channel?.parent_id ?? "none"}\` ${channel?.parent_id && watched.has(String(channel.parent_id)) ? "(watched)" : "**(NOT watched)**"}`
    ];

    const recent = cachedMessages(channelId).slice(-50).reverse();
    const withButtons = recent.find((m: any) => collectButtons(m.components).length > 0);

    if (!withButtons) {
        lines.push("", `No message with buttons in the last ${recent.length} cached messages here.`);
        return lines.join("\n");
    }

    const botId = ticketBotId();
    const authorOk = !botId || String(withButtons.author?.id) === botId;
    const buttons = collectButtons(withButtons.components);
    const match = matchTicket(withButtons);

    lines.push(
        "",
        `**Author:** \`${withButtons.author?.id}\` (${withButtons.author?.username ?? "?"}) ${authorOk ? "(matches)" : "**(does NOT match configured bot)**"}`,
        `**Buttons found (${buttons.length}):**`,
        ...buttons.map(b => [
            `- \`${String(b.label ?? "<no label>")}\` style=${b.style} disabled=${!!b.disabled}`,
            `  custom_id=\`${customIdOf(b) ?? "none"}\``,
            // The field names this build actually uses. When a button reads as
            // having no custom_id, this is what says whether it is spelled
            // differently or genuinely absent.
            `  keys=\`${Object.keys(b).join(", ")}\``
        ].join("\n")),
        "",
        match.ok
            ? `**Result:** would press **${match.target.label}**`
            : `**Result:** no match - ${match.reason}`
    );

    return lines.join("\n");
}

export default {
    onLoad() {
        initSettings();
        resetInteractionWatch();
        startInteractionWatch();
        startActivityTracking(onReturnedToForeground);

        FluxDispatcher.subscribe("MESSAGE_CREATE", onMessageCreate);
        FluxDispatcher.subscribe("MESSAGE_UPDATE", onMessageUpdate);
        FluxDispatcher.subscribe("CONNECTION_OPEN", onConnectionOpen);

        awayCheckTimer = setInterval(() => {
            // An exception here would kill the interval for the rest of the session.
            try {
                checkAwayDuringDraws();
                maybePeriodicSweep();
            } catch (err) {
                logger.error("Maintenance tick threw:", err);
            }
        }, AWAY_CHECK_INTERVAL_MS);

        unregisterCommand = registerCommand({
            name: "taq",
            description: "TicketAutoQueue diagnostics",
            options: [
                {
                    name: "action",
                    description: "status = show config and gates, test = dry-run the matcher here, sweep = join queues on already-open tickets",
                    type: OPTION_TYPE_STRING,
                    required: false
                }
            ],
            execute(args: any[], ctx: any) {
                const action = optionValue(args, "action", "status");
                const channelId = ctx?.channel?.id;

                if (action === "sweep") {
                    sendBotMessage(channelId, "Sweeping already-open tickets, one at a time. Watch the debug log.");
                    sweepOpenTickets().then(
                        s => {
                            const summary = `Sweep done: joined **${s.joined}**, failed **${s.failed}**, skipped **${s.skipped}** of **${s.candidates}** candidates.`;
                            logger.info(summary.replace(/\*/g, ""));
                            if (s.failed) toastFailure(`TicketAutoQueue: joined ${s.joined}, ${s.failed} failed`);
                            else toast(`TicketAutoQueue: joined ${s.joined} queue(s)`);
                            sendBotMessage(channelId, summary);
                        },
                        err => {
                            logger.error("sweep failed:", err);
                            sendBotMessage(channelId, `Sweep failed: ${err?.message ?? err}`);
                        }
                    );
                    return;
                }

                sendBotMessage(channelId, action === "test" ? testReport(channelId) : statusReport());
            }
        } as any);

        if (parseIdList(settings.categoryIds).size === 0) {
            logger.warn("No valid category IDs configured - plugin is inert until you set them.");
        }

        if (settings.catchUpOnStart) {
            startSweepTimer = setTimeout(() => void autoSweep("startup"), STORE_SETTLE_MS);
        }
    },

    onUnload() {
        FluxDispatcher.unsubscribe("MESSAGE_CREATE", onMessageCreate);
        FluxDispatcher.unsubscribe("MESSAGE_UPDATE", onMessageUpdate);
        FluxDispatcher.unsubscribe("CONNECTION_OPEN", onConnectionOpen);

        if (startSweepTimer !== null) clearTimeout(startSweepTimer);
        startSweepTimer = null;
        if (reconnectSweepTimer !== null) clearTimeout(reconnectSweepTimer);
        reconnectSweepTimer = null;
        if (foregroundSweepTimer !== null) clearTimeout(foregroundSweepTimer);
        foregroundSweepTimer = null;
        if (awayCheckTimer !== null) clearInterval(awayCheckTimer);
        awayCheckTimer = null;

        unregisterCommand?.();
        unregisterCommand = null;

        stopInteractionWatch();
        stopActivityTracking();
        resetGates();
        clearDraws();
        forgetSessionId();
        // Toggling the plugin off and on is the obvious thing to try after fixing a
        // permission, so a restart must not inherit the old "cannot read this" verdicts.
        clearUnreachable();
    },

    settings: Settings
};
