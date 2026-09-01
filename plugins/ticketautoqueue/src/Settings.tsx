/*
 * TicketAutoQueue for Kettu
 * Copyright (c) 2026 river and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * Ported from the Vencord plugin of the same name.
 */

// Vencord rendered this page from the settings declaration. Vendetta plugins ship
// their own component, so the rows are written out by hand here. Every numeric
// field is a text box - React Native has no number input - and is parsed on commit
// rather than on keystroke, so a half-deleted value never reaches the gates.

import { React, ReactNative } from "@vendetta/metro/common";
import { useProxy } from "@vendetta/storage";
import { Forms } from "@vendetta/ui/components";

import { DEFAULTS, parseNumber, settings, TaqSettings } from "./settings";

const { ScrollView } = ReactNative;
const { FormSection, FormSwitchRow, FormInput, FormDivider, FormText } = Forms;

type BooleanKey = { [K in keyof TaqSettings]: TaqSettings[K] extends boolean ? K : never }[keyof TaqSettings];
type StringKey = { [K in keyof TaqSettings]: TaqSettings[K] extends string ? K : never }[keyof TaqSettings];
type NumberKey = { [K in keyof TaqSettings]: TaqSettings[K] extends number ? K : never }[keyof TaqSettings];

function Switch({ setting, label, subLabel }: { setting: BooleanKey; label: string; subLabel: string; }) {
    return (
        <FormSwitchRow
            label={label}
            subLabel={subLabel}
            value={settings[setting]}
            onValueChange={(v: boolean) => { settings[setting] = v; }}
        />
    );
}

function TextRow({ setting, title, placeholder }: { setting: StringKey; title: string; placeholder?: string; }) {
    return (
        <FormInput
            title={title}
            placeholder={placeholder}
            value={settings[setting]}
            onChange={(v: string) => { settings[setting] = v; }}
        />
    );
}

/**
 * Kept as local text while it is being edited and only written back on blur:
 * committing every keystroke would persist "30" on the way to "30000", and the
 * gate reading it in between would use that value.
 */
function NumberRow({ setting, title }: { setting: NumberKey; title: string; }) {
    const [draft, setDraft] = React.useState(String(settings[setting]));

    return (
        <FormInput
            title={title}
            keyboardType="numeric"
            value={draft}
            onChange={(v: string) => setDraft(v)}
            onBlur={() => {
                const parsed = parseNumber(draft, DEFAULTS[setting]);
                settings[setting] = parsed;
                setDraft(String(parsed));
            }}
        />
    );
}

export default function Settings() {
    useProxy(settings);

    return (
        <ScrollView style={{ flex: 1 }}>
            <FormSection title="Master">
                <Switch
                    setting="armed"
                    label="Armed"
                    subLabel="Turn off to keep the plugin loaded but stop it pressing anything."
                />
            </FormSection>

            <FormSection title="What to watch">
                <TextRow
                    setting="categoryIds"
                    title="Category IDs"
                    placeholder="comma-separated category IDs"
                />
                <FormDivider />
                <TextRow
                    setting="buttonLabels"
                    title="Button labels"
                    placeholder="Join Queue"
                />
                <FormDivider />
                <TextRow
                    setting="ticketBotId"
                    title="Ticket bot user ID"
                    placeholder="empty = any author (not recommended)"
                />
                <FormText style={{ paddingHorizontal: 16, paddingBottom: 8 }}>
                    Setting the bot ID stops anyone baiting a press with a fake button.
                </FormText>
                <FormDivider />
                <TextRow
                    setting="channelNamePattern"
                    title="Channel name pattern"
                    placeholder="regex, e.g. ^ticket-"
                />
            </FormSection>

            <FormSection title="When to press">
                <Switch
                    setting="onlyWhenActive"
                    label="Only while you are using Discord"
                    subLabel="Requires the app in the foreground and recent activity. Prevents claiming a ticket you cannot service."
                />
                <FormDivider />
                <NumberRow setting="idleThresholdMs" title="Idle threshold (ms)" />
                <FormDivider />
                <TextRow
                    setting="activeHours"
                    title="Active hours"
                    placeholder="09:00-23:00, may wrap midnight"
                />
                <FormDivider />
                <NumberRow setting="minDelayMs" title="Minimum delay before pressing (ms)" />
                <FormDivider />
                <NumberRow setting="maxDelayMs" title="Maximum delay before pressing (ms)" />
                <FormDivider />
                <NumberRow setting="cooldownMs" title="Cooldown between presses (ms)" />
            </FormSection>

            <FormSection title="Catching up on missed tickets">
                <Switch
                    setting="sweepOnReconnect"
                    label="Sweep after reconnect"
                    subLabel="No message events arrive while the gateway is down, which on mobile is every time the app is suspended."
                />
                <FormDivider />
                <Switch
                    setting="catchUpOnStart"
                    label="Sweep on startup"
                    subLabel="Off by default: after time away this can join a burst of tickets at once."
                />
                <FormDivider />
                <NumberRow setting="periodicSweepMs" title="Periodic re-scan (ms, 0 = off)" />
                <FormDivider />
                <NumberRow setting="catchUpMaxAgeMs" title="Ignore tickets older than (ms)" />
            </FormSection>

            <FormSection title="Draws and alerts">
                <Switch
                    setting="notifyOnWin"
                    label="Alert when the draw picks you"
                    subLabel="Stays up until dismissed, because one you miss is worthless."
                />
                <FormDivider />
                <Switch
                    setting="autoNavigateOnWin"
                    label="Jump to the ticket on a win"
                    subLabel="Opens the channel as soon as you are selected."
                />
                <FormDivider />
                <Switch
                    setting="warnIfAwayOnDraw"
                    label="Warn if a draw closes while you are away"
                    subLabel="You stay in the queue either way - this never forfeits a ticket for you."
                />
                <FormDivider />
                <NumberRow setting="drawWarningLeadMs" title="Warning lead time (ms)" />
                <FormDivider />
                <NumberRow setting="drawWatchWindowMs" title="Draw watch window (ms)" />
            </FormSection>

            <FormSection title="Feedback">
                <Switch
                    setting="notifyOnJoin"
                    label="Toast on join or failure"
                    subLabel="Show a toast when a queue is joined or a press fails."
                />
                <FormDivider />
                <Switch
                    setting="verboseLogging"
                    label="Verbose logging"
                    subLabel="Log every match decision to the debug log. Use while setting up."
                />
            </FormSection>
        </ScrollView>
    );
}
