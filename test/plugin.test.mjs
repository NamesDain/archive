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

/**
 * Renders an element tree, invoking function components as it goes.
 *
 * The page composes its fields out of local components (TextSetting and friends),
 * so a createElement stub that only records its arguments never runs their bodies
 * and sees the wrapper's props rather than the field's. Calling function types is
 * what makes assertions about a field's onChange, description and errorMessage
 * mean anything.
 */
function walk(node, visit) {
    if (node === null || node === undefined || typeof node !== "object") return;
    if (Array.isArray(node)) {
        for (const child of node) walk(child, visit);
        return;
    }

    const { type, props } = node;
    if (typeof type === "function") {
        walk(type(props ?? {}), visit);
        return;
    }

    visit(type, props ?? {});
    walk(props?.children, visit);
}

/** A createElement that keeps children on props, so walk can descend. */
function recordingCreateElement() {
    return (type, props, ...children) => ({
        type,
        props: { ...(props ?? {}), children: children.length === 1 ? children[0] : children }
    });
}

/** Renders the settings page and returns what was drawn. */
function renderSettings(mock, plugin) {
    mock.vendetta.metro.common.React.createElement = recordingCreateElement();
    const tree = plugin.settings();

    const drawn = [];
    const byLabel = new Map();
    walk(tree, (type, props) => {
        drawn.push(typeof type === "string" ? type : type?.name ?? "component");
        if (props?.label) byLabel.set(props.label, props);
    });
    return { tree, drawn, byLabel };
}

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
        const mock = createMockVendetta();
        const plugin = evalPlugin(BUNDLE, mock.vendetta);
        plugin.onLoad();

        const { tree, drawn } = renderSettings(mock, plugin);

        assert.ok(tree, "the settings component must return an element");
        assert.ok(drawn.includes("ScrollView"), "expected the page to be scrollable");
        assert.ok(drawn.includes("TableRowGroup"), "expected modern grouped rows, not legacy Forms");
        assert.ok(drawn.includes("TableSwitchRow"), "expected modern switch rows");
        assert.ok(drawn.includes("TextInput"), "expected Discord's own text field");
        assert.ok(!drawn.includes("FormSection"), "legacy Forms should not be used when tables resolve");
        plugin.onUnload();
    });

    it("falls back to legacy Forms and a native field if the modern ones have moved", () => {
        const mock = createMockVendetta({ modernComponents: false });
        const plugin = evalPlugin(BUNDLE, mock.vendetta);
        plugin.onLoad();

        const { tree, drawn } = renderSettings(mock, plugin);

        assert.ok(tree, "the page must still render without the modern components");
        assert.ok(drawn.includes("ScrollView"), "expected the page to still be scrollable");
        assert.ok(drawn.includes("FormSection"), "expected the legacy group fallback");
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
    /** Renders the page and returns every field's props keyed by its label. */
    function renderFields() {
        const mock = createMockVendetta();
        const plugin = evalPlugin(BUNDLE, mock.vendetta);
        plugin.onLoad();
        const { byLabel } = renderSettings(mock, plugin);
        return { ...mock, plugin, fields: byLabel, rerender: () => renderSettings(mock, plugin).byLabel };
    }

    // The dialog this replaced resolved a component that no longer exists on
    // current Discord iOS, so calling it took the whole app down. The mock throws
    // the same error, which makes every test here a guard against bringing it back.
    it("never uses the input dialog that crashes the app", () => {
        const c = renderFields();

        for (const [, props] of c.fields) props.onChange?.("x");

        assert.equal(c.calls.inputAlerts.length, 0, "showInputAlert must not be called");
        c.plugin.onUnload();
    });

    it("edits a text setting in place", () => {
        const c = renderFields();

        c.fields.get("Category IDs").onChange("333333333333333333, 444444444444444444");

        assert.equal(c.storage.categoryIds, "333333333333333333, 444444444444444444");
        c.plugin.onUnload();
    });

    it("accepts the text either as a string or as a native change event", () => {
        const c = renderFields();

        c.fields.get("Button labels").onChange({ nativeEvent: { text: "Claim" } });

        assert.equal(c.storage.buttonLabels, "Claim", "the native fallback reports an event, not a string");
        c.plugin.onUnload();
    });

    it("flags input with no valid IDs instead of silently going inert", () => {
        const c = renderFields();

        assert.equal(c.fields.get("Category IDs").errorMessage, undefined, "empty is not an error");

        c.storage.categoryIds = "not-an-id";

        assert.match(c.rerender().get("Category IDs").errorMessage, /No valid IDs/);
        c.plugin.onUnload();
    });

    it("flags a regex that will not compile", () => {
        const c = renderFields();
        c.storage.channelNamePattern = "^ticket-[";

        assert.match(c.rerender().get("Channel name pattern").errorMessage, /valid regular expression/);
        c.plugin.onUnload();
    });

    it("flags a malformed active-hours window", () => {
        const c = renderFields();
        c.storage.activeHours = "9am-11pm";

        assert.match(c.rerender().get("Active hours").errorMessage, /HH:MM-HH:MM/);
        c.plugin.onUnload();
    });

    it("will not write a half-typed or cleared duration", () => {
        const c = renderFields();
        const field = c.fields.get("Cooldown between presses");

        field.onChange("three");
        assert.equal(c.storage.cooldownMs, 3000, "a non-numeric draft must not be stored");

        field.onChange("");
        assert.equal(c.storage.cooldownMs, 3000, "a cleared field must not store NaN");

        field.onChange("5000");
        assert.equal(c.storage.cooldownMs, 5000, "a valid number is stored");
        c.plugin.onUnload();
    });

    it("describes durations in readable units", () => {
        const c = renderFields();

        assert.equal(c.fields.get("Counts as away after").description, "5 minutes");
        assert.equal(c.fields.get("Cooldown between presses").description, "3 seconds");
        assert.equal(c.fields.get("Periodic re-scan").description, "Off");
        c.plugin.onUnload();
    });

    it("says plainly when nothing is configured yet", () => {
        const c = renderFields();

        assert.match(c.fields.get("Category IDs").description, /Nothing happens until/);
        assert.match(c.fields.get("Ticket bot user ID").description, /Any author/);
        c.plugin.onUnload();
    });

    it("resets every value to its default, but only after confirmation", () => {
        const c = renderFields();
        c.storage.armed = false;
        c.storage.categoryIds = "333333333333333333";

        c.fields.get("Reset all settings").onValueChange(true);

        assert.equal(c.calls.alerts.length, 1, "resetting must ask first");
        assert.equal(c.storage.armed, false, "nothing changes until the alert is confirmed");

        c.calls.alerts[0].onConfirm();

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

describe("the mobile store's key spelling", () => {
    // A real /taq test on a device reported an enabled, non-link button with
    // "custom_id=none" while label, style and disabled all read fine. Those three
    // are the only single-word keys in that set; the client had normalised
    // custom_id to customId. Reading one spelling only made every panel unmatchable.
    it("presses a panel whose custom_id is stored as camelCase", async () => {
        const c = loadConfigured();

        dispatch(c.fluxHandlers, "MESSAGE_CREATE", {
            message: makeTicketPanel({
                id: "900", channelId: TICKET_CHANNEL_ID, botId: BOT_ID, idKey: "camel"
            })
        });
        await settle();

        const interaction = c.calls.rest.find(r => r.url === "/interactions");
        assert.ok(interaction, "a camelCase custom_id must still match and press");
        assert.equal(
            interaction.body.data.custom_id,
            "join_claim_queue:1",
            "the wire format stays snake_case whatever the store used"
        );
        c.plugin.onUnload();
    });

    it("still presses a panel using the raw snake_case spelling", async () => {
        const c = loadConfigured();

        dispatch(c.fluxHandlers, "MESSAGE_CREATE", {
            message: makeTicketPanel({
                id: "901", channelId: TICKET_CHANNEL_ID, botId: BOT_ID, idKey: "snake"
            })
        });
        await settle();

        assert.ok(c.calls.rest.find(r => r.url === "/interactions"), "REST payloads keep snake_case");
        c.plugin.onUnload();
    });

    it("recognises a live draw panel whose Leave button uses camelCase", async () => {
        const c = loadConfigured();
        dispatch(c.fluxHandlers, "MESSAGE_CREATE", {
            message: makeTicketPanel({ id: "902", channelId: TICKET_CHANNEL_ID, botId: BOT_ID })
        });
        await settle();

        // The open panel lists everyone queued, us included, and keeps its Leave
        // button. Only the panel branch reads the countdown off it and adopts that
        // as the draw's deadline; an unreadable Leave button falls through to
        // "unrecognised" and leaves the default watch window in place. Asserting
        // on the adopted deadline is what separates those two, where asserting
        // "raised no alert" would pass either way.
        dispatch(c.fluxHandlers, "MESSAGE_CREATE", {
            message: {
                id: "903",
                channel_id: TICKET_CHANNEL_ID,
                author: { id: BOT_ID },
                content: "",
                components: [{
                    type: 17,
                    components: [
                        { type: 10, content: `In queue: <@${SELF_ID}> - ends <t:9999999999:R>` },
                        { type: 1, components: [{ type: 2, style: 4, label: "Leave Queue", customId: "leave_claim_queue:1" }] }
                    ]
                }]
            }
        });

        assert.equal(c.calls.alerts.length, 0, "an open panel is never a win");

        c.registeredCommands[0].execute(
            [{ name: "action", value: "status" }],
            { channel: { id: TICKET_CHANNEL_ID } }
        );
        const status = c.calls.botMessages.at(-1).content;
        const secondsLeft = Number(/ticket-0001 \((\d+)s left\)/.exec(status)?.[1]);

        assert.ok(
            secondsLeft > 100000,
            `expected the panel's own countdown to be adopted, got ${secondsLeft}s ` +
            "(the 600s default means the Leave button was never read)"
        );
        c.plugin.onUnload();
    });

    it("reports the button's real key names in /taq test", () => {
        const c = loadConfigured();
        const panel = makeTicketPanel({
            id: "904", channelId: TICKET_CHANNEL_ID, botId: BOT_ID, idKey: "camel"
        });
        c.stores.MessageStore._messages.set(TICKET_CHANNEL_ID, { _array: [panel] });

        c.registeredCommands[0].execute(
            [{ name: "action", value: "test" }],
            { channel: { id: TICKET_CHANNEL_ID } }
        );

        const report = c.calls.botMessages[0].content;
        assert.match(report, /keys=/, "the report must name the fields this build actually uses");
        assert.match(report, /customId/, "so a wrong guess about the spelling is visible immediately");
        assert.match(report, /would press \*\*Join Queue\*\*/);
        c.plugin.onUnload();
    });
});

describe("what a press actually claims", () => {
    // Discord answers /interactions as soon as it accepts the press for delivery.
    // A 204 does not mean the bot handled it - a panel can still show "This
    // interaction failed" afterwards. Saying "joined the queue" on that basis told
    // an operator they were in a queue they were not in.
    it("reports sending the press, not joining the queue", async () => {
        const c = loadConfigured();

        dispatch(c.fluxHandlers, "MESSAGE_CREATE", {
            message: makeTicketPanel({ id: "950", channelId: TICKET_CHANNEL_ID, botId: BOT_ID })
        });
        await settle();

        assert.equal(c.calls.toasts.length, 1, "one toast per press");
        const text = c.calls.toasts[0].content;
        assert.match(text, /Pressed/, "the toast must describe what was done");
        assert.doesNotMatch(text, /Joined queue/i, "it must not claim a join it cannot know about");
        c.plugin.onUnload();
    });

    it("reports whether a gateway session is held, without printing it", () => {
        const c = loadConfigured();

        c.registeredCommands[0].execute(
            [{ name: "action", value: "status" }],
            { channel: { id: TICKET_CHANNEL_ID } }
        );

        const report = c.calls.botMessages.at(-1).content;
        assert.match(report, /\*\*Gateway session:\*\* held via CONNECTION_OPEN/);
        assert.doesNotMatch(report, /sess-abc/, "the session id is a live credential, never printed whole");
        c.plugin.onUnload();
    });

    it("says plainly when no session is held, since no press can work", () => {
        const mock = createMockVendetta();
        const plugin = evalPlugin(BUNDLE, mock.vendetta);
        plugin.onLoad();
        Object.assign(mock.storage, { categoryIds: CATEGORY_ID, ticketBotId: BOT_ID });
        // No CONNECTION_OPEN dispatched, so nothing ever supplied a session.

        plugin.settings && mock.registeredCommands[0].execute(
            [{ name: "action", value: "status" }],
            { channel: { id: TICKET_CHANNEL_ID } }
        );

        assert.match(mock.calls.botMessages.at(-1).content, /NONE — presses cannot work/);
        plugin.onUnload();
    });
});
