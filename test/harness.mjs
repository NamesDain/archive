// A stand-in for the parts of Kettu a plugin touches at runtime.
//
// This exists because the plugin cannot be exercised on a device from CI, and the
// failure modes that matter most - a bad interaction body, a flux subscription
// that is never removed - are all observable from outside. The mock records every
// call so a test can assert on it.

/**
 * @param {object} [options]
 * @param {boolean} [options.modernComponents] false makes findByProps miss the
 *   table components, so the settings page falls back to legacy Forms - the
 *   path a build that moved them would take.
 */
export function createMockVendetta({ modernComponents = true } = {}) {
    const calls = {
        toasts: [],
        alerts: [],
        inputAlerts: [],
        rest: [],
        botMessages: [],
        navigations: [],
        logs: []
    };

    const fluxHandlers = new Map();
    const registeredCommands = [];
    const storage = {};

    const FluxDispatcher = {
        subscribe(event, handler) {
            if (!fluxHandlers.has(event)) fluxHandlers.set(event, new Set());
            fluxHandlers.get(event).add(handler);
        },
        unsubscribe(event, handler) {
            fluxHandlers.get(event)?.delete(handler);
        },
        dispatch(payload) {
            calls.navigations.push(payload);
        }
    };

    const RestAPI = {
        async get(options) {
            calls.rest.push({ method: "get", ...options });
            return { body: [] };
        },
        async post(options) {
            calls.rest.push({ method: "post", ...options });
            return { body: {} };
        },
        async del(options) {
            calls.rest.push({ method: "del", ...options });
            return { body: {} };
        },
        getAPIBaseURL: () => "https://discord.com/api/v9"
    };

    const stores = {
        ChannelStore: {
            _channels: new Map(),
            getChannel(id) { return this._channels.get(String(id)); }
        },
        MessageStore: {
            _messages: new Map(),
            getMessages(channelId) { return this._messages.get(String(channelId)) ?? null; },
            getMessage(channelId, messageId) {
                const list = this._messages.get(String(channelId));
                return list?._array?.find(m => String(m.id) === String(messageId)) ?? null;
            }
        },
        UserStore: {
            _self: { id: "111111111111111111" },
            getCurrentUser() { return this._self; }
        },
        SelectedChannelStore: { getChannelId: () => null },
        GuildChannelStore: { _byGuild: new Map(), getChannels(id) { return this._byGuild.get(String(id)); } }
    };

    // AppState starts foregrounded so the presence gate is open by default; a test
    // that cares about the gate flips this.
    const AppState = {
        currentState: "active",
        _handlers: new Set(),
        addEventListener(_event, handler) {
            this._handlers.add(handler);
            return { remove: () => this._handlers.delete(handler) };
        }
    };

    const vendetta = {
        logger: {
            log: (...a) => calls.logs.push(["log", ...a]),
            info: (...a) => calls.logs.push(["info", ...a]),
            warn: (...a) => calls.logs.push(["warn", ...a]),
            error: (...a) => calls.logs.push(["error", ...a])
        },
        commands: {
            registerCommand(command) {
                registeredCommands.push(command);
                return () => {
                    const i = registeredCommands.indexOf(command);
                    if (i >= 0) registeredCommands.splice(i, 1);
                };
            }
        },
        metro: {
            findByProps(...props) {
                if (props.includes("TableRowGroup")) {
                    return modernComponents
                        ? { TableRowGroup: "TableRowGroup", TableSwitchRow: "TableSwitchRow", TableRow: "TableRow" }
                        : undefined;
                }
                if (props.includes("Stack")) return modernComponents ? { Stack: "Stack" } : undefined;
                if (props.includes("getAPIBaseURL")) return RestAPI;
                if (props.includes("sendBotMessage")) {
                    return { sendBotMessage: (channelId, content) => calls.botMessages.push({ channelId, content }) };
                }
                if (props.includes("transitionToGuild")) {
                    return { transitionToGuild: (guildId, channelId) => calls.navigations.push({ guildId, channelId }) };
                }
                // getSessionId is deliberately absent: the real client resolves the
                // session from CONNECTION_OPEN, and the tests must exercise that path.
                return undefined;
            },
            findByStoreName(name) {
                return stores[name];
            },
            common: {
                FluxDispatcher,
                ReactNative: { AppState, Vibration: { vibrate() {} }, ScrollView: "ScrollView", View: "View" },
                React: { useState: v => [v, () => {}], createElement: () => null }
            }
        },
        plugin: { id: "ticketautoqueue/", storage },
        storage: { useProxy: s => s },
        ui: {
            components: {
                Forms: {
                    FormSection: "FormSection",
                    FormSwitchRow: "FormSwitchRow",
                    FormInput: "FormInput",
                    FormDivider: "FormDivider",
                    FormText: "FormText"
                }
            },
            alerts: {
                showConfirmationAlert: options => calls.alerts.push(options),
                showInputAlert: options => calls.inputAlerts.push(options)
            },
            assets: { getAssetIDByName: () => 1 },
            toasts: { showToast: (content, asset) => calls.toasts.push({ content, asset }) }
        }
    };

    return { vendetta, calls, fluxHandlers, registeredCommands, storage, stores, AppState, RestAPI };
}

/** Evaluates a built bundle exactly the way Kettu's VdPluginManager does. */
export function evalPlugin(js, vendetta) {
    const raw = (0, eval)(`vendetta=>{return ${js}}`)(vendetta);
    const ret = typeof raw === "function" ? raw() : raw;
    return ret?.default ?? ret ?? {};
}

/** Fires one flux event at every handler the plugin subscribed. */
export function dispatch(fluxHandlers, event, payload) {
    for (const handler of fluxHandlers.get(event) ?? []) handler(payload);
}

export function makeChannel({ id, name, parentId, guildId = "999999999999999999" }) {
    return { id, name, parent_id: parentId, guild_id: guildId };
}

export function makeTicketPanel({ id, channelId, botId, label = "Join Queue", customId = "join_claim_queue:1" }) {
    return {
        id,
        channel_id: channelId,
        author: { id: botId, username: "TicketBot" },
        application_id: botId,
        flags: 0,
        content: "",
        components: [
            {
                type: 17,
                components: [
                    { type: 10, content: "A new ticket is open. Selection ends <t:9999999999:R>" },
                    { type: 1, components: [{ type: 2, style: 1, label, custom_id: customId }] }
                ]
            }
        ]
    };
}
