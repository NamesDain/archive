/*
 * TicketAutoQueue for Kettu
 * Copyright (c) 2026 river and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * Ported from the Vencord plugin of the same name.
 */

// Editing happens in fields on the page, not in a dialog.
//
// The dialog version crashed the app. Kettu's showInputAlert renders its input
// inside LegacyAlert, which it resolves by the display name "FluxContainer(Alert)"
// - and that component no longer exists in current Discord iOS, so tapping any
// text row threw "byDisplayName(FluxContainer(Alert)) is undefined" and took
// Discord down with it. Nothing here may depend on that component.
//
// An inline TextInput inside a TableRowGroup is what Discord's own settings use
// and what shipped plugins on this client do. It also gives validation somewhere
// better to live: the field shows the problem as you type, rather than waiting
// for a confirm button.

import { find, findByProps } from "@vendetta/metro";
import { React, ReactNative } from "@vendetta/metro/common";
import { useProxy } from "@vendetta/storage";
import { showConfirmationAlert } from "@vendetta/ui/alerts";
import { Forms } from "@vendetta/ui/components";

import { parseHourWindow } from "./hours";
import {
    DEFAULTS, parseIdList, parseLabelList, parsePattern, settings, settingText, TaqSettings
} from "./settings";
import { toast } from "./ui";

const { ScrollView, View } = ReactNative;

const tables = findByProps("TableRowGroup", "TableSwitchRow");

// Legacy shims, kept only so the page still renders on a build where the table
// components have moved. They take the same props as the modern ones.
const LegacyGroup = ({ title, children }: any) =>
    <Forms.FormSection title={title}>{children}</Forms.FormSection>;
const LegacySwitchRow = ({ label, subLabel, value, onValueChange }: any) =>
    <Forms.FormSwitchRow label={label} subLabel={subLabel} value={value} onValueChange={onValueChange} />;

const Group = tables?.TableRowGroup ?? LegacyGroup;
const SwitchRow = tables?.TableSwitchRow ?? LegacySwitchRow;

// Discord's own spacing primitive. A plain View is the fallback rather than a
// `gap` style, which needs React Native 0.71 and is not in every build here.
const Stack = findByProps("Stack")?.Stack;
const Container = Stack ?? View;
const containerProps: any = {
    style: { paddingVertical: 16, paddingHorizontal: 12 },
    ...(Stack ? { spacing: 16 } : {})
};

/**
 * Discord's text field lives in a module that exports nothing else, which is how
 * the client itself finds it; a plain findByProps can land on an unrelated module
 * that happens to re-export one. React Native's own TextInput is the last resort -
 * it looks nothing like the rest of the page, but it cannot be missing.
 */
const DiscordTextInput =
    find((m: any) => m?.TextInput && Object.keys(m).length === 1)?.TextInput
    ?? findByProps("TextInput")?.TextInput;
const Field = DiscordTextInput ?? (ReactNative as any).TextInput;
const fieldIsNative = !DiscordTextInput;

type StringKey = { [K in keyof TaqSettings]: TaqSettings[K] extends string ? K : never }[keyof TaqSettings];
type NumberKey = { [K in keyof TaqSettings]: TaqSettings[K] extends number ? K : never }[keyof TaqSettings];

/** Discord's field reports a string; React Native's reports an event. Accept either. */
function changedText(value: any): string {
    if (typeof value === "string") return value;
    return value?.nativeEvent?.text ?? value?.text ?? "";
}

/** Only the bare React Native fallback needs styling; Discord's field styles itself. */
const nativeFieldStyle = fieldIsNative
    ? { padding: 12, margin: 12, borderRadius: 8, backgroundColor: "#1e1f22", color: "#f2f3f5" }
    : undefined;

function TextSetting({ setting, label, placeholder, describe, validate }: {
    setting: StringKey;
    label: string;
    placeholder: string;
    describe?: (value: string) => string | undefined;
    validate?: (value: string) => string | undefined;
}) {
    const value = settingText(settings[setting]);
    const problem = validate?.(value);

    const onChange = (raw: any) => { settings[setting] = changedText(raw); };

    return (
        <Field
            label={label}
            placeholder={placeholder}
            placeholderTextColor="#80848e"
            value={value}
            // Discord's field calls onChange with the text, React Native's calls
            // onChangeText with it. Passing both means neither needs a special case.
            onChange={onChange}
            onChangeText={onChange}
            description={problem ? undefined : describe?.(value)}
            errorMessage={problem}
            state={problem ? "error" : "default"}
            isClearable
            style={nativeFieldStyle}
        />
    );
}

/**
 * Numbers are held as text while being edited and only written back once they
 * parse. Committing every keystroke would store 30 on the way to 30000, and a
 * cleared field would store NaN - which compares false against every threshold
 * and would quietly disable whichever gate reads it.
 */
function NumberSetting({ setting, label, hint }: { setting: NumberKey; label: string; hint: string; }) {
    const [draft, setDraft] = React.useState(String(settings[setting]));

    const parsed = Number(draft.trim());
    const valid = draft.trim() !== "" && Number.isFinite(parsed) && parsed >= 0;

    const onChange = (raw: any) => {
        const text = changedText(raw);
        setDraft(text);
        const next = Number(text.trim());
        if (text.trim() !== "" && Number.isFinite(next) && next >= 0) settings[setting] = next;
    };

    return (
        <Field
            label={label}
            placeholder={hint}
            placeholderTextColor="#80848e"
            keyboardType="numeric"
            value={draft}
            onChange={onChange}
            onChangeText={onChange}
            description={valid ? describeMs(parsed) : undefined}
            errorMessage={valid ? undefined : "Enter a whole number of milliseconds, 0 or higher."}
            state={valid ? "default" : "error"}
            style={nativeFieldStyle}
        />
    );
}

/** Durations are stored in milliseconds; nobody wants to read "300000" unaided. */
function describeMs(ms: number): string {
    if (ms === 0) return "Off";
    const round = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(1));
    const seconds = ms / 1000;
    if (seconds < 1) return `${ms} ms`;
    if (seconds < 60) return `${round(seconds)} seconds`;
    const minutes = seconds / 60;
    if (minutes < 60) return `${round(minutes)} minutes`;
    return `${round(minutes / 60)} hours`;
}

export default function Settings() {
    useProxy(settings);

    return (
        <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingBottom: 48 }}>
            <Container {...containerProps}>
                <Group title="Master">
                    <SwitchRow
                        label="Armed"
                        subLabel="Stays loaded but presses nothing"
                        value={settings.armed}
                        onValueChange={(v: boolean) => { settings.armed = v; }}
                    />
                </Group>

                <Group title="What to watch">
                    <TextSetting
                        setting="categoryIds"
                        label="Category IDs"
                        placeholder="comma-separated IDs"
                        describe={value => {
                            const found = parseIdList(value).size;
                            return found ? `${found} watched` : "Nothing happens until you add one";
                        }}
                        validate={value => value && parseIdList(value).size === 0
                            ? "No valid IDs. Each is 17-20 digits, separated by commas."
                            : undefined}
                    />
                    <TextSetting
                        setting="buttonLabels"
                        label="Button labels"
                        placeholder="Join Queue"
                        describe={() => "Case-insensitive, comma-separated"}
                        validate={value => parseLabelList(value).length === 0
                            ? "Give at least one label to press."
                            : undefined}
                    />
                    <TextSetting
                        setting="ticketBotId"
                        label="Ticket bot user ID"
                        placeholder="empty allows any author"
                        describe={value => value ? undefined : "Any author — not recommended"}
                        validate={value => value && parseIdList(value).size !== 1
                            ? "Enter one user ID of 17-20 digits, or leave empty."
                            : undefined}
                    />
                    <TextSetting
                        setting="channelNamePattern"
                        label="Channel name pattern"
                        placeholder="regex, e.g. ^ticket-"
                        describe={value => value ? undefined : "No name filter"}
                        validate={value => value && !parsePattern(value)
                            ? "Not a valid regular expression."
                            : undefined}
                    />
                </Group>

                <Group title="When to press">
                    <SwitchRow
                        label="Only while you are using Discord"
                        subLabel="Foreground and recent activity"
                        value={settings.onlyWhenActive}
                        onValueChange={(v: boolean) => { settings.onlyWhenActive = v; }}
                    />
                    <NumberSetting setting="idleThresholdMs" label="Counts as away after" hint="milliseconds" />
                    <TextSetting
                        setting="activeHours"
                        label="Active hours"
                        placeholder="09:00-23:00"
                        describe={value => value ? undefined : "Any time"}
                        validate={value => value && !parseHourWindow(value)
                            ? "Use HH:MM-HH:MM. It may wrap midnight."
                            : undefined}
                    />
                    <NumberSetting setting="minDelayMs" label="Minimum delay before pressing" hint="milliseconds" />
                    <NumberSetting setting="maxDelayMs" label="Maximum delay before pressing" hint="milliseconds" />
                    <NumberSetting setting="cooldownMs" label="Cooldown between presses" hint="milliseconds" />
                </Group>

                <Group title="Catching up on missed tickets">
                    <SwitchRow
                        label="Sweep after reconnect"
                        subLabel="Catches tickets missed while suspended"
                        value={settings.sweepOnReconnect}
                        onValueChange={(v: boolean) => { settings.sweepOnReconnect = v; }}
                    />
                    <SwitchRow
                        label="Sweep on startup"
                        subLabel="May join a burst after time away"
                        value={settings.catchUpOnStart}
                        onValueChange={(v: boolean) => { settings.catchUpOnStart = v; }}
                    />
                    <NumberSetting setting="periodicSweepMs" label="Periodic re-scan" hint="milliseconds, 0 for off" />
                    <NumberSetting setting="catchUpMaxAgeMs" label="Ignore tickets older than" hint="milliseconds" />
                </Group>

                <Group title="Draws and alerts">
                    <SwitchRow
                        label="Alert when the draw picks you"
                        subLabel="Stays up until dismissed"
                        value={settings.notifyOnWin}
                        onValueChange={(v: boolean) => { settings.notifyOnWin = v; }}
                    />
                    <SwitchRow
                        label="Jump to the ticket on a win"
                        subLabel="Opens the channel for you"
                        value={settings.autoNavigateOnWin}
                        onValueChange={(v: boolean) => { settings.autoNavigateOnWin = v; }}
                    />
                    <SwitchRow
                        label="Warn if a draw closes while away"
                        subLabel="Never forfeits your place"
                        value={settings.warnIfAwayOnDraw}
                        onValueChange={(v: boolean) => { settings.warnIfAwayOnDraw = v; }}
                    />
                    <NumberSetting setting="drawWarningLeadMs" label="Warning lead time" hint="milliseconds" />
                    <NumberSetting setting="drawWatchWindowMs" label="Draw watch window" hint="milliseconds" />
                </Group>

                <Group title="Feedback">
                    <SwitchRow
                        label="Toast on join or failure"
                        value={settings.notifyOnJoin}
                        onValueChange={(v: boolean) => { settings.notifyOnJoin = v; }}
                    />
                    <SwitchRow
                        label="Verbose logging"
                        subLabel="Log every match decision"
                        value={settings.verboseLogging}
                        onValueChange={(v: boolean) => { settings.verboseLogging = v; }}
                    />
                    <SwitchRow
                        label="Reset all settings"
                        subLabel="Turn on to restore every default"
                        value={false}
                        onValueChange={confirmReset}
                    />
                </Group>
            </Container>
        </ScrollView>
    );
}

/**
 * A switch rather than a tappable row, so it needs no component beyond the ones
 * already on this page. The confirmation is still attempted, and if it cannot
 * open, the reset is abandoned rather than done silently.
 */
function confirmReset(on: boolean): void {
    if (!on) return;

    const reset = () => {
        for (const [key, value] of Object.entries(DEFAULTS)) (settings as any)[key] = value;
        toast("TicketAutoQueue: settings reset");
    };

    try {
        showConfirmationAlert({
            title: "Reset TicketAutoQueue?",
            content: "Every setting goes back to its default, including your category IDs.",
            confirmText: "Reset",
            // Kettu passes this straight through as a string; vendetta-types
            // narrows it to an enum it does not export usefully here.
            confirmColor: "red" as any,
            cancelText: "Cancel",
            onConfirm: reset
        });
    } catch {
        toast("Could not open the confirmation — nothing was reset");
    }
}
