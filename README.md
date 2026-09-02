# TicketAutoQueue

Presses the **Join Queue** button on support tickets in configured categories, only while
you are actually using Discord.

A port of the Vencord (desktop) plugin to mobile, in the Vendetta plugin format — so it
installs from a URL in **Kettu**, and should work unchanged in Bunny and Revenge, which
expose the same API.

## Install

One-time repo setup: **Settings → Pages → Source: Deploy from a branch**, branch `main`,
folder **`/docs`**. Save, then give it a minute to publish.

Then in the app, **Settings → Plugins → +** and paste:

```
https://namesdain.github.io/archive/ticketautoqueue/
```

The trailing slash matters — the loader appends `manifest.json` to it.

The built plugin is committed under `docs/`, and Pages serves that folder directly. No
GitHub Actions runner is involved in publishing, so the plugin ships whether or not CI can
run. `npm run build` refreshes `docs/`; commit it and Pages picks it up on push.

### Installing without GitHub at all

The loader only needs `manifest.json` and `index.js` reachable over HTTPS from one
directory. Run `npm install && npm run build` and host `docs/ticketautoqueue/` anywhere
that serves static files.

## Setup

At minimum, open the plugin's settings and set:

| Setting | Why |
| --- | --- |
| **Category IDs** | The categories tickets are opened under, comma-separated. The plugin is inert until this is set. |
| **Ticket bot user ID** | Strongly recommended. Without it, any account that can post a button in a watched category can bait a press. |

Then `/taq status` in any channel to check what it thinks it's watching, and `/taq test` in a
ticket channel to dry-run the matcher against the panel there without pressing anything.

## Commands

| Command | Does |
| --- | --- |
| `/taq status` | Config, gate state, pending draws, last sweep, whether press confirmation works on this build. The default with no argument. |
| `/taq stats` | Presses, wins, losses and win rate for this session. |
| `/taq test` | Dry-runs the matcher against the most recent panel in the current channel. Reports every button it found, its real field names, and why it would or would not press. |
| `/taq sweep` | Joins queues on tickets that are already open, one at a time. |
| `/taq pause for:30m` | Stops joining for a while. Accepts `90s`, `45m`, `2h`, or a bare number of minutes; defaults to 30 minutes. Survives a restart. |
| `/taq resume` | Lifts a pause early. |

They all reply with a bot message only you can see.

**Pause rather than disarming** when you step away: a pause states when it ends and
comes back on its own, where Armed stays off until you remember it. Claiming a ticket
you cannot service is the failure this plugin exists to avoid.

### Not taking on too much at once

**Most queues at once** caps how many draws you can be in simultaneously. It counts
open draws, not tickets touched, so a resolved one stops occupying a slot. It is `0`
(no limit) by default — declining a ticket somebody expected to be claimed is worse
than being in one queue too many, so the limit is opt-in.

## What changed from the desktop version

The matching, draw-tracking and rate-limit logic is unchanged. `draws.ts`, `hours.ts` and
`unreachable.ts` are byte-identical to the originals below their licence headers. What had to
change is everything that touched a desktop-only API:

**The presence gate.** Desktop measured whether you were at your machine from `mousemove`,
`keydown`, `click` and page visibility. A phone at rest produces none of those. Presence is now
*Discord is in the foreground* **and** *you did something in it within the idle threshold* —
where "something" is foregrounding the app, switching channels, or sending a message. Both
halves are required: foreground alone would keep claiming tickets off a phone left face-up on a
desk, which is the exact failure the desktop idle gate existed to prevent.

**Pressing the button.** Desktop tried an `/interactions` POST and fell back to clicking the
rendered button in the DOM. React Native has no DOM, so the REST path is the only one. It needs
a gateway `session_id`, which desktop read from `AuthenticationStore`; mobile has no such store,
so the id is taken from the `CONNECTION_OPEN` dispatch the plugin already subscribes to. A press
attempted before any connect is refused with its own distinct reason rather than a confusing 400.

**Notifications.** There is no desktop-notification API from inside the mobile client. The two
alerts that matter — you won the draw, and a draw is closing while you are away — are modals
that stay up until dismissed, with the jump-to-ticket action on the confirm button, plus a
vibration. Routine join/fail feedback is still a toast.

**Listing a guild's channels for a sweep.** Desktop used `GuildChannelStore.getSelectableChannels`.
Mobile has no such store, and which accessor `ChannelStore` exposes has moved between builds, so
several are tried in turn and a single `GET /guilds/{id}/channels` is the backstop. Sweeps are
floored at one a minute, so that is at most one extra request per guild per minute, and only when
no store accessor answers.

**Settings.** Vencord generated the settings page from the settings declaration. Vendetta plugins
ship their own component, so the page is written out by hand, on Discord's current table
components. Values are edited in fields on the page rather than a dialog: Kettu's `showInputAlert`
renders inside a legacy alert that no longer exists on current Discord iOS, and tapping a row that
used it crashed the app. Numeric fields hold a draft and commit only a valid parse, so a
half-typed value never reaches the gates as `NaN`.

### Catching up after the app has been away

While Discord is backgrounded its gateway connection drops and its timers stop, so tickets opened
in that window arrive as no event at all. Exactly how long the OS allows before that happens is not
something this project has measured — treat it as "expect gaps", not as a precise limit.

What the plugin does about it: both a gateway reconnect **and** a return to the foreground trigger
a catch-up sweep, each wake gets one sweep even if another ran moments earlier, and the sweep can
list channels over REST when the store is still cold. A draw closes in roughly a minute, so the
wake path is deliberately quick.

Anything still open when you come back should be caught. A draw that opened and closed entirely
while the app was away cannot be — no code running inside Discord can press a button during a
window in which it was not running.

## Development

```sh
npm install
npm run typecheck
npm test        # builds, then runs the suite against dist/
```

`npm run build` writes two copies of the same output: `dist/` (gitignored, what the tests
load) and `docs/` (committed, what Pages serves). **Commit `docs/` whenever the plugin
changes** — otherwise installed copies keep the old build, since the `hash` in
`manifest.json` is what tells them they are out of date. CI fails the build if `docs/` is
stale against the sources.

The suite loads the built bundle and evaluates it through the same
`vendetta => { return <bundle> }` wrapper Kettu's loader uses, against a mock client
(`test/harness.mjs`). That covers the things that are painful to find on a device: the interaction
body it puts on the wire, every gate that should stop a press, the draw outcomes, flux
subscriptions being removed on unload, and the settings page rendering.

It does **not** cover whether the module lookups in `src/discord.ts` resolve against a real
Discord build — nothing offline can. If the plugin loads but never matches anything, run
`/taq test` in a ticket channel and turn on **Verbose logging**; the store lookups are all in that
one file.

## Licence

GPL-3.0-or-later, as the original.
