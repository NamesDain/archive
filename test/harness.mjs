// A stand-in for the parts of Kettu a plugin touches at runtime.
//
// This exists because the plugin cannot be exercised on a device from CI, and the
// failure modes that matter most - a bad interaction body, a flux subscription
// that is never removed - are all observable from outside. The mock records every
// call so a test can assert on it.

// The plugin keeps a maintenance setInterval alive between onLoad and onUnload. A
// test that fails before reaching its cleanup leaves that interval running, and
// node --test then hangs forever instead of printing the failure - which is a far
// worse outcome than the failing assertion itself. Unreferencing intervals lets
// the process exit and report. Only intervals: unreferencing timeouts too would
// let node exit while a test is still awaiting one. That onUnload really does
// clear them is asserted directly, so this hides nothing.
const realSetInterval = globalThis.setInterval;
globalThis.setInterval = (...args) => {
    const handle = realSetInterval(...args);
    handle?.unref?.();
    return handle;
};

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

    // How the client answers each interaction, consumed in order. "joined" and
    // "rejected" dispatch the matching outcome event; "silent" dispatches nothing,
    // standing in for a build that never reports outcomes.
    //
    // Defaults to "joined" because that is the healthy case and it resolves at
    // once; leaving it silent would make every press in every test sit out the
    // full outcome timeout.
    const interactionOutcomes = [];
    let moduleSessionId = null;
    const nextOutcome = () => (interactionOutcomes.length ? interactionOutcomes.shift() : "joined");

    const RestAPI = {
        async get(options) {
            calls.rest.push({ method: "get", ...options });
            return { body: [] };
        },
        async post(options) {
            calls.rest.push({ method: "post", ...options });

            if (options?.url === "/interactions") {
                const outcome = nextOutcome();
                const nonce = options.body?.nonce;
                if (outcome === "joined" || outcome === "rejected") {
                    // The real client dispatches this a moment after the request.
                    setTimeout(() => {
                        const event = outcome === "joined" ? "INTERACTION_SUCCESS" : "INTERACTION_FAILURE";
                        for (const handler of fluxHandlers.get(event) ?? []) handler({ nonce });
                    }, 1);
                }
            }

            return { body: {}, status: 204 };
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
                // The client's live session id, as a module lookup would report it.
                if (props.includes("getSessionId")) {
                    return moduleSessionId === null ? undefined : { getSessionId: () => moduleSessionId };
                }
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
            find(predicate) {
                // Discord's text field lives in a module exporting nothing else.
                const candidates = modernComponents ? [{ TextInput: "TextInput" }] : [];
                return candidates.find(predicate);
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
                showInputAlert: options => {
                    calls.inputAlerts.push(options);
                    throw new Error("bunny.metro.byDisplayName(FluxContainer(Alert)) is undefined! (id unknown)");
                }
            },
            assets: { getAssetIDByName: () => 1 },
            toasts: { showToast: (content, asset) => calls.toasts.push({ content, asset }) }
        }
    };

    return {
        vendetta, calls, fluxHandlers, registeredCommands, storage, stores, AppState, RestAPI,
        interactionOutcomes,
        /** Stands in for the client's own session id, which changes on every reconnect. */
        setModuleSessionId(id) { moduleSessionId = id; }
    };
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

/**
 * A snowflake encoding "just now".
 *
 * Channel age is read straight out of the ID, and the sweep discards anything
 * older than catchUpMaxAgeMs. A hand-written ID like 444444444444444444 decodes
 * to 2018, so any test that expects a sweep to consider a channel has to mint a
 * current one rather than invent digits.
 */
export function snowflakeNow(offsetMs = 0) {
    return String(BigInt(Date.now() + offsetMs - 1420070400000) << 22n);
}

export function makeChannel({ id, name, parentId, guildId = "999999999999999999" }) {
    return { id, name, parent_id: parentId, guild_id: guildId };
}

/**
 * @param {object} o
 * @param {"snake"|"camel"} [o.idKey] which spelling the client stored custom_id
 *   under. Mobile normalises it to camelCase; gateway and REST payloads keep
 *   snake_case, so the plugin has to read a panel either way.
 */
export function makeTicketPanel({ id, channelId, botId, label = "Join Queue", customId = "join_claim_queue:1", idKey = "snake" }) {
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
                    {
                        type: 1,
                        components: [{
                            type: 2,
                            style: 1,
                            label,
                            ...(idKey === "camel" ? { customId } : { custom_id: customId })
                        }]
                    }
                ]
            }
        ]
    };
}
