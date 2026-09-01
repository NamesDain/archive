import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { after, before, describe, it } from "node:test";

import {
    createMockVendetta, dispatch, evalPlugin, makeChannel, makeTicketPanel
} from "./harness.mjs";

const BUNDLE = await readFile("./dist/ticketautoqueue/index.js", "utf8");

const BOT_ID = "222222222222222222";
const CATEGORY_ID = "333333333333333333";
const TICKET_CHANNEL_ID = "444444444444444444";
const GUILD_ID = "999999999999999999";
const SELF_ID = "111111111111111111";

/** A loaded plugin with a watched category and one open ticket channel in the store. */
function loadConfigured(overrides = {}) {
    const mock = createMockVendetta();
    const plugin = evalPlugin(BUNDLE, mock.vendetta);

    plugin.onLoad();

    Object.assign(mock.storage, {
        categoryIds: CATEGORY_ID,
        ticketBotId: BOT_ID,
        // Presses are delayed by a random 300-800ms by default; zero keeps the
        // tests deterministic without stubbing timers.
        minDelayMs: 0,
        maxDelayMs: 0,
        cooldownMs: 0,
        ...overrides
    });

    mock.stores.ChannelStore._channels.set(
        CATEGORY_ID,
        makeChannel({ id: CATEGORY_ID, name: "support", parentId: null, guildId: GUILD_ID })
    );
    mock.stores.ChannelStore._channels.set(
        TICKET_CHANNEL_ID,
        makeChannel({ id: TICKET_CHANNEL_ID, name: "ticket-0001", parentId: CATEGORY_ID, guildId: GUILD_ID })
    );

    // Every press needs a gateway session id, which the plugin only learns here.
    dispatch(mock.fluxHandlers, "CONNECTION_OPEN", { sessionId: "sess-abc" });

    return { ...mock, plugin };
}

const settle = () => new Promise(r => setTimeout(r, 60));

describe("loading", () => {
    it("evaluates under Kettu's eval wrapper and exports the plugin shape", () => {
        const { vendetta } = createMockVendetta();
        const plugin = evalPlugin(BUNDLE, vendetta);

        assert.equal(typeof plugin.onLoad, "function");
        assert.equal(typeof plugin.onUnload, "function");
        assert.equal(typeof plugin.settings, "function");
    });

    it("writes its defaults into plugin storage on load", () => {
        const { vendetta, storage } = createMockVendetta();
        const plugin = evalPlugin(BUNDLE, vendetta);

        plugin.onLoad();

        assert.equal(storage.armed, true);
        assert.equal(storage.buttonLabels, "Join Queue");
        assert.equal(storage.onlyWhenActive, true);
        assert.equal(storage.idleThresholdMs, 300000);
        plugin.onUnload();
    });

    it("keeps a value the user already set", () => {
        const { vendetta, storage } = createMockVendetta();
        storage.buttonLabels = "Claim";
        storage.armed = false;

        const plugin = evalPlugin(BUNDLE, vendetta);
        plugin.onLoad();

        assert.equal(storage.buttonLabels, "Claim");
        assert.equal(storage.armed, false);
        plugin.onUnload();
    });

    it("renders its settings page on Discord's current table components", () => {
        const { vendetta } = createMockVendetta();
        const created = [];
        vendetta.metro.common.React.createElement = (type, props, ...children) => {
            created.push(typeof type === "string" ? type : type?.name ?? "component");
            return { type, props, children };
        };

        const plugin = evalPlugin(BUNDLE, vendetta);
        plugin.onLoad();

        const tree = plugin.settings();

        assert.ok(tree, "the settings component must return an element");
        assert.ok(created.includes("ScrollView"), "expected the page to be scrollable");
        assert.ok(created.includes("TableRowGroup"), "expected modern grouped rows, not legacy Forms");
        assert.ok(created.includes("TableSwitchRow"), "expected modern switch rows");
        assert.ok(!created.includes("FormSection"), "legacy Forms should not be used when tables resolve");
        plugin.onUnload();
    });

    it("falls back to legacy Forms if the table components have moved", () => {
        const { vendetta } = createMockVendetta({ modernComponents: false });
        const created = [];
        vendetta.metro.common.React.createElement = (type, props, ...children) => {
            created.push(typeof type === "string" ? type : type?.name ?? "component");
            return { type, props, children };
        };

        const plugin = evalPlugin(BUNDLE, vendetta);
        plugin.onLoad();

        assert.ok(plugin.settings(), "the page must still render without the table components");
        assert.ok(created.includes("ScrollView"), "expected the page to still be scrollable");
        plugin.onUnload();
    });

    it("subscribes and registers on load, and undoes all of it on unload", () => {
        const { vendetta, fluxHandlers, registeredCommands } = createMockVendetta();
        const plugin = evalPlugin(BUNDLE, vendetta);

        plugin.onLoad();
        assert.equal(fluxHandlers.get("MESSAGE_CREATE").size, 1);
        assert.equal(fluxHandlers.get("MESSAGE_UPDATE").size, 1);
        assert.equal(fluxHandlers.get("CONNECTION_OPEN").size, 1);
        assert.equal(fluxHandlers.get("CHANNEL_SELECT").size, 1);
        assert.equal(registeredCommands.length, 1);
        assert.equal(registeredCommands[0].name, "taq");

        plugin.onUnload();
        assert.equal(fluxHandlers.get("MESSAGE_CREATE").size, 0);
        assert.equal(fluxHandlers.get("MESSAGE_UPDATE").size, 0);
        assert.equal(fluxHandlers.get("CONNECTION_OPEN").size, 0);
        assert.equal(fluxHandlers.get("CHANNEL_SELECT").size, 0);
        assert.equal(registeredCommands.length, 0);
    });
});

describe("editing a setting from the page", () => {
    /** Renders the page and returns the row props keyed by label. */
    function renderRows() {
        const mock = createMockVendetta();
        const rows = new Map();
        mock.vendetta.metro.common.React.createElement = (type, props, ...children) => {
            if (props?.label) rows.set(props.label, props);
            return { type, props, children };
        };

        const plugin = evalPlugin(BUNDLE, mock.vendetta);
        plugin.onLoad();
        plugin.settings();
        return { ...mock, plugin, rows };
    }

    it("opens an input dialog seeded with the current value", () => {
        const c = renderRows();
        c.rows.get("Button labels").onPress();

        assert.equal(c.calls.inputAlerts.length, 1);
        assert.equal(c.calls.inputAlerts[0].initialValue, "Join Queue");
        c.plugin.onUnload();
    });

    it("saves a valid value", async () => {
        const c = renderRows();
        c.rows.get("Categories").onPress();

        await c.calls.inputAlerts[0].onConfirm("333333333333333333, 444444444444444444");

        assert.equal(c.storage.categoryIds, "333333333333333333, 444444444444444444");
        c.plugin.onUnload();
    });

    it("rejects input with no valid IDs instead of silently going inert", async () => {
        const c = renderRows();
        const before = c.storage.categoryIds;
        c.rows.get("Categories").onPress();

        await assert.rejects(
            () => Promise.resolve(c.calls.inputAlerts[0].onConfirm("not-an-id")),
            /No valid IDs/
        );
        assert.equal(c.storage.categoryIds, before, "a rejected value must not be written");
        c.plugin.onUnload();
    });

    it("rejects a regex that will not compile", async () => {
        const c = renderRows();
        c.rows.get("Channel name pattern").onPress();

        await assert.rejects(
            () => Promise.resolve(c.calls.inputAlerts[0].onConfirm("^ticket-[")),
            /not a valid regular expression/
        );
        c.plugin.onUnload();
    });

    it("rejects a malformed active-hours window", async () => {
        const c = renderRows();
        c.rows.get("Active hours").onPress();

        await assert.rejects(
            () => Promise.resolve(c.calls.inputAlerts[0].onConfirm("9am-11pm")),
            /HH:MM-HH:MM/
        );
        c.plugin.onUnload();
    });

    it("rejects a non-numeric duration rather than storing NaN", async () => {
        const c = renderRows();
        c.rows.get("Cooldown between presses").onPress();

        await assert.rejects(
            () => Promise.resolve(c.calls.inputAlerts[0].onConfirm("three seconds")),
            /number of milliseconds/
        );
        assert.equal(c.storage.cooldownMs, 3000, "the old value must survive a rejected edit");
        c.plugin.onUnload();
    });

    it("shows durations in readable units, not raw milliseconds", () => {
        const c = renderRows();

        assert.equal(c.rows.get("Counts as away after").subLabel, "5 min");
        assert.equal(c.rows.get("Cooldown between presses").subLabel, "3s");
        assert.equal(c.rows.get("Periodic re-scan").subLabel, "Off");
        c.plugin.onUnload();
    });

    it("says plainly when nothing is configured yet", () => {
        const c = renderRows();

        assert.match(c.rows.get("Categories").subLabel, /^Not set/);
        assert.match(c.rows.get("Ticket bot").subLabel, /Any author/);
        c.plugin.onUnload();
    });

    it("resets every value to its default", () => {
        const c = renderRows();
        c.storage.armed = false;
        c.storage.categoryIds = "333333333333333333";

        c.rows.get("Reset all settings").onPress();

        assert.equal(c.storage.armed, true);
        assert.equal(c.storage.categoryIds, "");
        c.plugin.onUnload();
    });
});

describe("pressing the button", () => {
    let ctx;
    before(() => { ctx = loadConfigured(); });
    after(() => ctx.plugin.onUnload());

    it("sends a well-formed component interaction for a matching panel", async () => {
        dispatch(ctx.fluxHandlers, "MESSAGE_CREATE", {
            message: makeTicketPanel({ id: "555", channelId: TICKET_CHANNEL_ID, botId: BOT_ID })
        });
        await settle();

        const interaction = ctx.calls.rest.find(c => c.url === "/interactions");
        assert.ok(interaction, "expected an /interactions POST");
        assert.equal(interaction.method, "post");

        const { body } = interaction;
        assert.equal(body.type, 3, "MESSAGE_COMPONENT");
        assert.equal(body.guild_id, GUILD_ID);
        assert.equal(body.channel_id, TICKET_CHANNEL_ID);
        assert.equal(body.message_id, "555");
        assert.equal(body.application_id, BOT_ID);
        assert.equal(body.session_id, "sess-abc", "session id must come from CONNECTION_OPEN");
        assert.equal(body.data.component_type, 2);
        assert.equal(body.data.custom_id, "join_claim_queue:1");
        assert.ok(body.nonce, "a nonce is required");
    });

    it("does not press the same ticket twice", async () => {
        const before = ctx.calls.rest.filter(c => c.url === "/interactions").length;

        dispatch(ctx.fluxHandlers, "MESSAGE_CREATE", {
            message: makeTicketPanel({ id: "556", channelId: TICKET_CHANNEL_ID, botId: BOT_ID })
        });
        await settle();

        const now = ctx.calls.rest.filter(c => c.url === "/interactions").length;
        assert.equal(now, before, "the channel is already claimed for this session");
    });
});

describe("the gates that stop a press", () => {
    const cases = [
        {
            name: "a message from someone other than the configured ticket bot",
            setup: c => ({ message: makeTicketPanel({ id: "601", channelId: TICKET_CHANNEL_ID, botId: "888888888888888888" }) })
        },
        {
            name: "a channel outside the watched categories",
            setup: c => {
                c.stores.ChannelStore._channels.set(
                    "777777777777777777",
                    makeChannel({ id: "777777777777777777", name: "general", parentId: "666666666666666666", guildId: GUILD_ID })
                );
                return { message: makeTicketPanel({ id: "602", channelId: "777777777777777777", botId: BOT_ID }) };
            }
        },
        {
            name: "a button whose label is not configured",
            setup: () => ({ message: makeTicketPanel({ id: "603", channelId: TICKET_CHANNEL_ID, botId: BOT_ID, label: "Close Ticket" }) })
        },
        {
            name: "a disabled button",
            setup: () => {
                const message = makeTicketPanel({ id: "604", channelId: TICKET_CHANNEL_ID, botId: BOT_ID });
                message.components[0].components[1].components[0].disabled = true;
                return { message };
            }
        },
        {
            name: "the plugin being disarmed",
            setup: c => {
                c.storage.armed = false;
                return { message: makeTicketPanel({ id: "605", channelId: TICKET_CHANNEL_ID, botId: BOT_ID }) };
            }
        },
        {
            name: "the channel name failing the configured pattern",
            setup: c => {
                c.storage.channelNamePattern = "^support-";
                return { message: makeTicketPanel({ id: "606", channelId: TICKET_CHANNEL_ID, botId: BOT_ID }) };
            }
        },
        {
            name: "being outside the active hours window",
            setup: c => {
                // A one-minute window an hour in the past: never now.
                const past = new Date(Date.now() - 3600000);
                const hh = String(past.getHours()).padStart(2, "0");
                const mm = String(past.getMinutes()).padStart(2, "0");
                c.storage.activeHours = `${hh}:${mm}-${hh}:${mm === "59" ? "59" : String(Number(mm) + 1).padStart(2, "0")}`;
                return { message: makeTicketPanel({ id: "607", channelId: TICKET_CHANNEL_ID, botId: BOT_ID }) };
            }
        },
        {
            name: "Discord being in the background",
            setup: c => {
                c.AppState.currentState = "background";
                return { message: makeTicketPanel({ id: "608", channelId: TICKET_CHANNEL_ID, botId: BOT_ID }) };
            }
        }
    ];

    for (const { name, setup } of cases) {
        it(`refuses to press on ${name}`, async () => {
            const c = loadConfigured();
            const event = setup(c);

            dispatch(c.fluxHandlers, "MESSAGE_CREATE", event);
            await settle();

            const interactions = c.calls.rest.filter(r => r.url === "/interactions");
            assert.equal(interactions.length, 0, `should not have pressed: ${name}`);
            c.plugin.onUnload();
        });
    }

    it("presses once the app returns to the foreground", async () => {
        const c = loadConfigured();
        c.AppState.currentState = "background";

        dispatch(c.fluxHandlers, "MESSAGE_CREATE", {
            message: makeTicketPanel({ id: "609", channelId: TICKET_CHANNEL_ID, botId: BOT_ID })
        });
        await settle();
        assert.equal(c.calls.rest.filter(r => r.url === "/interactions").length, 0);

        c.AppState.currentState = "active";
        for (const handler of c.AppState._handlers) handler("active");

        dispatch(c.fluxHandlers, "MESSAGE_CREATE", {
            message: makeTicketPanel({ id: "610", channelId: TICKET_CHANNEL_ID, botId: BOT_ID })
        });
        await settle();
        assert.equal(c.calls.rest.filter(r => r.url === "/interactions").length, 1);
        c.plugin.onUnload();
    });

    it("refuses to press with no gateway session id", async () => {
        const mock = createMockVendetta();
        const plugin = evalPlugin(BUNDLE, mock.vendetta);
        plugin.onLoad();
        Object.assign(mock.storage, {
            categoryIds: CATEGORY_ID, ticketBotId: BOT_ID, minDelayMs: 0, maxDelayMs: 0, cooldownMs: 0
        });
        mock.stores.ChannelStore._channels.set(
            TICKET_CHANNEL_ID,
            makeChannel({ id: TICKET_CHANNEL_ID, name: "ticket-0002", parentId: CATEGORY_ID, guildId: GUILD_ID })
        );
        // Deliberately no CONNECTION_OPEN.

        dispatch(mock.fluxHandlers, "MESSAGE_CREATE", {
            message: makeTicketPanel({ id: "611", channelId: TICKET_CHANNEL_ID, botId: BOT_ID })
        });
        await settle();

        assert.equal(mock.calls.rest.filter(r => r.url === "/interactions").length, 0);
        plugin.onUnload();
    });
});

describe("the draw", () => {
    /** Joins a queue so the channel has a tracked, live draw. */
    async function withJoinedQueue() {
        const c = loadConfigured();
        dispatch(c.fluxHandlers, "MESSAGE_CREATE", {
            message: makeTicketPanel({ id: "700", channelId: TICKET_CHANNEL_ID, botId: BOT_ID })
        });
        await settle();
        assert.equal(c.calls.rest.filter(r => r.url === "/interactions").length, 1, "setup: should have joined");
        return c;
    }

    function announcement(text) {
        return {
            id: "701",
            channel_id: TICKET_CHANNEL_ID,
            author: { id: BOT_ID },
            content: "",
            components: [{ type: 17, components: [{ type: 10, content: text }] }]
        };
    }

    it("alerts and navigates when the winner is you", async () => {
        const c = await withJoinedQueue();

        dispatch(c.fluxHandlers, "MESSAGE_CREATE", {
            message: announcement(`👍 Selected staff: <@${SELF_ID}>`)
        });

        assert.equal(c.calls.alerts.length, 1, "a win must raise a dismissable alert");
        assert.match(c.calls.alerts[0].title, /assigned to you/i);
        assert.ok(c.calls.navigations.length >= 1, "autoNavigateOnWin should open the channel");
        c.plugin.onUnload();
    });

    it("stays silent when the winner is someone else", async () => {
        const c = await withJoinedQueue();

        dispatch(c.fluxHandlers, "MESSAGE_CREATE", {
            message: announcement("👍 Selected staff: <@888888888888888888>")
        });

        assert.equal(c.calls.alerts.length, 0, "losing must not alert");
        c.plugin.onUnload();
    });

    it("does not treat the still-open panel's own mention of you as a win", async () => {
        const c = await withJoinedQueue();

        // The live panel lists everyone queued, including us, and keeps its Leave
        // button. Reading a mention here as a result declared a win for every loser.
        dispatch(c.fluxHandlers, "MESSAGE_CREATE", {
            message: {
                id: "702",
                channel_id: TICKET_CHANNEL_ID,
                author: { id: BOT_ID },
                content: "",
                components: [{
                    type: 17,
                    components: [
                        { type: 10, content: `In queue: <@${SELF_ID}> - selection ends <t:9999999999:R>` },
                        { type: 1, components: [{ type: 2, style: 4, label: "Leave", custom_id: "leave_claim_queue:1" }] }
                    ]
                }]
            }
        });

        assert.equal(c.calls.alerts.length, 0, "an open panel is not a result");
        c.plugin.onUnload();
    });
});

describe("the /taq command", () => {
    it("reports status without touching the network", async () => {
        const c = loadConfigured();
        const command = c.registeredCommands[0];

        command.execute([{ name: "action", value: "status" }], { channel: { id: TICKET_CHANNEL_ID } });

        assert.equal(c.calls.botMessages.length, 1);
        const report = c.calls.botMessages[0].content;
        assert.match(report, /\*\*Armed:\*\*/);
        assert.match(report, /\*\*Presence gate:\*\*/);
        assert.match(report, new RegExp(CATEGORY_ID));
        c.plugin.onUnload();
    });

    it("defaults to status when no action is given", async () => {
        const c = loadConfigured();
        c.registeredCommands[0].execute([], { channel: { id: TICKET_CHANNEL_ID } });

        assert.equal(c.calls.botMessages.length, 1);
        assert.match(c.calls.botMessages[0].content, /\*\*Armed:\*\*/);
        c.plugin.onUnload();
    });

    it("dry-runs the matcher against the cached panel for `test`", async () => {
        const c = loadConfigured();
        const panel = makeTicketPanel({ id: "800", channelId: TICKET_CHANNEL_ID, botId: BOT_ID });
        c.stores.MessageStore._messages.set(TICKET_CHANNEL_ID, { _array: [panel] });

        c.registeredCommands[0].execute([{ name: "action", value: "test" }], { channel: { id: TICKET_CHANNEL_ID } });

        const report = c.calls.botMessages[0].content;
        assert.match(report, /would press \*\*Join Queue\*\*/);
        assert.match(report, /\(watched\)/);
        c.plugin.onUnload();
    });
});

describe("the sweep", () => {
    it("falls back to REST when no channel store accessor works", async () => {
        const c = loadConfigured();
        // GuildChannelStore.getChannels returns nothing for this guild, which is the
        // situation on mobile builds that have no such store at all.
        await c.registeredCommands[0].execute([{ name: "action", value: "sweep" }], { channel: { id: TICKET_CHANNEL_ID } });
        await settle();

        const guildFetch = c.calls.rest.find(r => r.url === `/guilds/${GUILD_ID}/channels`);
        assert.ok(guildFetch, "expected the guild-channels REST fallback");
        assert.equal(guildFetch.method, "get");
        c.plugin.onUnload();
    });

    it("uses the store when it does answer, without a REST call", async () => {
        const c = loadConfigured();
        c.stores.GuildChannelStore._byGuild.set(GUILD_ID, {
            SELECTABLE: [{ channel: makeChannel({ id: TICKET_CHANNEL_ID, name: "ticket-0001", parentId: CATEGORY_ID, guildId: GUILD_ID }) }]
        });

        await c.registeredCommands[0].execute([{ name: "action", value: "sweep" }], { channel: { id: TICKET_CHANNEL_ID } });
        await settle();

        assert.equal(
            c.calls.rest.filter(r => r.url === `/guilds/${GUILD_ID}/channels`).length,
            0,
            "the store answered, so no guild fetch should happen"
        );
        c.plugin.onUnload();
    });
});
