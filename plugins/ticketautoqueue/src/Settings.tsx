/*
 * TicketAutoQueue for Kettu
 * Copyright (c) 2026 river and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * Ported from the Vencord plugin of the same name.
 */

// Built on Discord's current table components rather than the legacy Forms set.
// Forms still resolves, but it renders as an unstyled run of rows on modern
// builds - which is what this page looked like before.
//
// Text and numeric settings open an input dialog on tap instead of embedding a
// field in the row. That reads better on a phone, and it gives each value a
// place to be validated: showInputAlert keeps the dialog open and shows the
// message when onConfirm rejects, so a bad category ID or an uncompilable regex
// is caught at the point of entry rather than silently making the plugin inert.

import { findByProps } from "@vendetta/metro";
import { React, ReactNative } from "@vendetta/metro/common";
import { useProxy } from "@vendetta/storage";
import { showInputAlert } from "@vendetta/ui/alerts";
import { Forms } from "@vendetta/ui/components";

import { parseHourWindow } from "./hours";
import { DEFAULTS, parseIdList, parseLabelList, parsePattern, settings, TaqSettings } from "./settings";

const { ScrollView, View } = ReactNative;

const tables = findByProps("TableRowGroup", "TableSwitchRow");

// Legacy shims, kept only so the page still renders on a build where the table
// components have moved. They take the same props as the modern ones.
const LegacyGroup = ({ title, children }: any) =>
    <Forms.FormSection title={title}>{children}</Forms.FormSection>;
const LegacySwitchRow = ({ label, subLabel, value, onValueChange }: any) =>
    <Forms.FormSwitchRow label={label} subLabel={subLabel} value={value} onValueChange={onValueChange} />;
const LegacyRow = ({ label, subLabel, onPress }: any) =>
    <Forms.FormRow label={label} subLabel={subLabel} onPress={onPress} />;

const Group = tables?.TableRowGroup ?? LegacyGroup;
const SwitchRow = tables?.TableSwitchRow ?? LegacySwitchRow;
const Row = tables?.TableRow ?? LegacyRow;

// Discord's own spacing primitive. A plain View is the fallback rather than a
// `gap` style, which needs React Native 0.71 and is not in every build here.
const Stack = findByProps("Stack")?.Stack;
const Container = Stack ?? View;
const containerProps: any = {
    style: { paddingVertical: 16, paddingHorizontal: 12 },
    ...(Stack ? { spacing: 16 } : {})
};

type BooleanKey = { [K in keyof TaqSettings]: TaqSettings[K] extends boolean ? K : never }[keyof TaqSettings];
type StringKey = { [K in keyof TaqSettings]: TaqSettings[K] extends string ? K : never }[keyof TaqSettings];
type NumberKey = { [K in keyof TaqSettings]: TaqSettings[K] extends number ? K : never }[keyof TaqSettings];

/** Durations are stored in milliseconds; nobody wants to read "300000" in a list. */
function formatMs(ms: number): string {
    if (!Number.isFinite(ms)) return "not set";
    if (ms === 0) return "off";
    if (ms < 1000) return `${ms} ms`;
    const round = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(1));
    const seconds = ms / 1000;
    if (seconds < 60) return `${round(seconds)}s`;
    const minutes = seconds / 60;
    if (minutes < 60) return `${round(minutes)} min`;
    return `${round(minutes / 60)} h`;
}

/**
 * showInputAlert closes on a resolved promise and shows the message on a rejected
 * one. Rejecting rather than throwing is deliberate: it calls onConfirm inside
 * `Promise.resolve(...)`, so a synchronous throw would escape the press handler
 * instead of reaching its catch.
 */
const invalid = (message: string) => Promise.reject(new Error(message));

function editText(
    key: StringKey,
    title: string,
    placeholder: string,
    validate?: (value: string) => string | null
) {
    showInputAlert({
        title,
        initialValue: settings[key],
        placeholder,
        confirmText: "Save",
        cancelText: "Cancel",
        onConfirm: (input: string) => {
            const value = input.trim();
            const problem = validate?.(value);
            if (problem) return invalid(problem);
            settings[key] = value;
        }
    });
}

function editNumber(key: NumberKey, title: string, hint: string) {
    showInputAlert({
        title,
        initialValue: String(settings[key]),
        placeholder: hint,
        confirmText: "Save",
        cancelText: "Cancel",
        onConfirm: (input: string) => {
            const value = Number(input.trim());
            if (!Number.isFinite(value) || value < 0) {
                return invalid("Enter a number of milliseconds, 0 or higher.");
            }
            settings[key] = value;
        }
    });
}

export default function Settings() {
    useProxy(settings);

    const categories = parseIdList(settings.categoryIds);
    const labels = parseLabelList(settings.buttonLabels);

    return (
        <ScrollView style={{ flex: 1 }}>
            <Container {...containerProps}>
                <Group title="Master">
                    <SwitchRow
                        label="Armed"
                        subLabel="Turn off to keep the plugin loaded but stop it pressing anything."
                        value={settings.armed}
                        onValueChange={(v: boolean) => { settings.armed = v; }}
                    />
                </Group>

                <Group title="What to watch">
                    <Row
                        label="Categories"
                        subLabel={categories.size
                            ? `${categories.size} watched: ${[...categories].join(", ")}`
                            : "Not set — the plugin does nothing until you add one"}
                        onPress={() => editText(
                            "categoryIds",
                            "Category IDs",
                            "comma-separated IDs",
                            value => value && parseIdList(value).size === 0
                                ? "No valid IDs found. Each must be 17-20 digits, separated by commas."
                                : null
                        )}
                    />
                    <Row
                        label="Button labels"
                        subLabel={labels.length ? labels.join(", ") : "Not set — nothing will match"}
                        onPress={() => editText(
                            "buttonLabels",
                            "Button labels",
                            "Join Queue",
                            value => parseLabelList(value).length === 0
                                ? "Give at least one label to press."
                                : null
                        )}
                    />
                    <Row
                        label="Ticket bot"
                        subLabel={settings.ticketBotId
                            ? settings.ticketBotId
                            : "Any author — anyone could bait a press with a fake button"}
                        onPress={() => editText(
                            "ticketBotId",
                            "Ticket bot user ID",
                            "leave empty to allow any author",
                            value => value && parseIdList(value).size !== 1
                                ? "Enter a single user ID of 17-20 digits, or leave it empty."
                                : null
                        )}
                    />
                    <Row
                        label="Channel name pattern"
                        subLabel={settings.channelNamePattern || "No name filter"}
                        onPress={() => editText(
                            "channelNamePattern",
                            "Channel name pattern",
                            "regex, e.g. ^ticket-",
                            value => value && !parsePattern(value)
                                ? "That is not a valid regular expression."
                                : null
                        )}
                    />
                </Group>

                <Group title="When to press">
                    <SwitchRow
                        label="Only while you are using Discord"
                        subLabel="Needs the app in the foreground and recent activity. Stops it claiming a ticket you cannot service."
                        value={settings.onlyWhenActive}
                        onValueChange={(v: boolean) => { settings.onlyWhenActive = v; }}
                    />
                    <Row
                        label="Counts as away after"
                        subLabel={formatMs(settings.idleThresholdMs)}
                        onPress={() => editNumber("idleThresholdMs", "Idle threshold", "milliseconds")}
                    />
                    <Row
                        label="Active hours"
                        subLabel={settings.activeHours || "Any time"}
                        onPress={() => editText(
                            "activeHours",
                            "Active hours",
                            "09:00-23:00",
                            value => value && !parseHourWindow(value)
                                ? "Use HH:MM-HH:MM, for example 09:00-23:00. It may wrap midnight."
                                : null
                        )}
                    />
                    <Row
                        label="Delay before pressing"
                        subLabel={`${formatMs(settings.minDelayMs)} to ${formatMs(settings.maxDelayMs)}`}
                        onPress={() => editNumber("minDelayMs", "Minimum delay", "milliseconds")}
                    />
                    <Row
                        label="Maximum delay"
                        subLabel={formatMs(settings.maxDelayMs)}
                        onPress={() => editNumber("maxDelayMs", "Maximum delay", "milliseconds")}
                    />
                    <Row
                        label="Cooldown between presses"
                        subLabel={formatMs(settings.cooldownMs)}
                        onPress={() => editNumber("cooldownMs", "Cooldown", "milliseconds")}
                    />
                </Group>

                <Group title="Catching up on missed tickets">
                    <SwitchRow
                        label="Sweep after reconnect"
                        subLabel="No messages arrive while the gateway is down, which on mobile is every time the app is suspended."
                        value={settings.sweepOnReconnect}
                        onValueChange={(v: boolean) => { settings.sweepOnReconnect = v; }}
                    />
                    <SwitchRow
                        label="Sweep on startup"
                        subLabel="Off by default: after time away this can join a burst of tickets at once."
                        value={settings.catchUpOnStart}
                        onValueChange={(v: boolean) => { settings.catchUpOnStart = v; }}
                    />
                    <Row
                        label="Periodic re-scan"
                        subLabel={settings.periodicSweepMs > 0 ? `Every ${formatMs(settings.periodicSweepMs)}` : "Off"}
                        onPress={() => editNumber("periodicSweepMs", "Periodic re-scan", "milliseconds, 0 to disable")}
                    />
                    <Row
                        label="Ignore tickets older than"
                        subLabel={formatMs(settings.catchUpMaxAgeMs)}
                        onPress={() => editNumber("catchUpMaxAgeMs", "Maximum ticket age", "milliseconds")}
                    />
                </Group>

                <Group title="Draws and alerts">
                    <SwitchRow
                        label="Alert when the draw picks you"
                        subLabel="Stays up until dismissed, because one you miss is worthless."
                        value={settings.notifyOnWin}
                        onValueChange={(v: boolean) => { settings.notifyOnWin = v; }}
                    />
                    <SwitchRow
                        label="Jump to the ticket on a win"
                        subLabel="Opens the channel as soon as you are selected."
                        value={settings.autoNavigateOnWin}
                        onValueChange={(v: boolean) => { settings.autoNavigateOnWin = v; }}
                    />
                    <SwitchRow
                        label="Warn if a draw closes while you are away"
                        subLabel="You stay in the queue either way — this never forfeits a ticket for you."
                        value={settings.warnIfAwayOnDraw}
                        onValueChange={(v: boolean) => { settings.warnIfAwayOnDraw = v; }}
                    />
                    <Row
                        label="Warning lead time"
                        subLabel={formatMs(settings.drawWarningLeadMs)}
                        onPress={() => editNumber("drawWarningLeadMs", "Warning lead time", "milliseconds")}
                    />
                    <Row
                        label="Draw watch window"
                        subLabel={formatMs(settings.drawWatchWindowMs)}
                        onPress={() => editNumber("drawWatchWindowMs", "Draw watch window", "milliseconds")}
                    />
                </Group>

                <Group title="Feedback">
                    <SwitchRow
                        label="Toast on join or failure"
                        value={settings.notifyOnJoin}
                        onValueChange={(v: boolean) => { settings.notifyOnJoin = v; }}
                    />
                    <SwitchRow
                        label="Verbose logging"
                        subLabel="Log every match decision. Turn this on while setting up, then use /taq test in a ticket."
                        value={settings.verboseLogging}
                        onValueChange={(v: boolean) => { settings.verboseLogging = v; }}
                    />
                    <Row
                        label="Reset all settings"
                        subLabel="Puts every value back to its default."
                        onPress={() => {
                            for (const [key, value] of Object.entries(DEFAULTS)) {
                                (settings as any)[key] = value;
                            }
                        }}
                    />
                </Group>
            </Container>
        </ScrollView>
    );
}
