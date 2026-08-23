# OpenCode Mobile Plugin

Mobile push notifications for OpenCode via Expo. Connect your phone to receive notifications when OpenCode generates responses, even when you're away from your computer.

## Release Notes

### Unreleased

- **Mobile web overlay.** The tunnel now points at the plugin, which reverse-proxies
  OpenCode and injects a mobile stylesheet plus a session switcher into its web UI.
  See [Mobile web overlay](#mobile-web-overlay).
- Notifications: the title now names the project instead of a constant, expanded
  bodies keep the agent's line structure, errors get the same body budget and
  expanded style as completions, and iOS thread grouping is set on every
  notification kind rather than only completions.
- Fixed: the Cloudflare provider ignored its injected `spawn` on the default
  (free-tier) path; `ensureNgrokReady` hung on an stdin prompt in any
  non-interactive context such as CI; and an upgrade socket's peer was not torn
  down on close.
- Removed dead code: `assistant-message.ts`, `log-level-test.ts`, `sdk-logger.ts`,
  `src/push/notification-handler.ts`.
- Test suite grown to 672 tests with an enforced 85% coverage threshold
  (`npx vitest run --coverage`).
- **Removed four unused dependencies**: `cloudflared`, `cloudflared-tunnel`,
  `expo` and `ngrok` (the v5 beta; `@ngrok/ngrok` is the one actually used).
  None were imported. This drops the install from 1,243 packages to 292 and
  fixes an `npm install` failure in `cloudflared`'s postinstall -- see
  [Install fails on cloudflared](#install-fails-on-cloudflared).

### v1.2.x -> v1.3.10

- Added `update` command support: `npx opencode-mobile update` (with `--check` mode)
- Installer now supports automation-friendly flags: `--yes`, `--provider`, `--skip-update-check`, and token/domain options
- Added notification filtering controls via `npx opencode-mobile filters`
- Improved Cloudflare setup: official package repos on Linux, Homebrew flow on macOS, and winget support on Windows

## Prerequisites

- [OpenCode CLI](https://opencode.ai) installed and configured
- Node.js or Bun runtime
- Mobile device with OpenCode Mobile app (or Expo Go)

## Quick Start

### Step 1: Install the Plugin

```bash
npx opencode-mobile install
```

**What this does:**
- Installs `opencode-mobile@latest` plugin to your global OpenCode config
- Creates the `/mobile` command (available in all projects)
- Sets up tunnel provider configuration for mobile connectivity

**Expected output:**
```
✅ Updated ~/.config/opencode/opencode.json
   plugin: ["opencode-mobile@latest"]

✅ Created /mobile command at ~/.config/opencode/commands/mobile.md

🚀 Setting up tunnel provider for mobile notifications...

🎉 Installation complete!
   Restart OpenCode (run `opencode`) to load the plugin.
   Use `/mobile` in any project to access mobile features.
```

### Step 2: Start OpenCode

```bash
opencode attach
```

Or start a new session:

```bash
opencode serve
```

**What you'll see:**
```
[opencode-mobile] v1.3.10
[PushPlugin][Mobile] Entry loaded: index.ts

Connecting to OpenCode...
Connected! Session ID: abc123

>
```

### Step 3: Get Your QR Code

Inside OpenCode, type:

```
/mobile
```

**What you'll see:**
```
> /mobile

┌─────────────────┐
│ █▀▀▀▀▀█ ▀▄▀▄▀▄  │
│ █ ███ █  ▄▀ ▄▀  │
│ █ ▀▀▀ █ ▀▄▀▄▀▄  │
│ ▀▀▀▀▀▀▀ ▀▄█▄▀▄  │
│ ▀▄▀▄▀▄▀ █▄▀▄▀▄  │
└─────────────────┘

https://your-tunnel-url.ngrok.io
```

### Step 4: Connect Your Phone

1. **Install the OpenCode Mobile app** (or use Expo Go)
2. **Open the app** and look for the QR scanner
3. **Scan the QR code** displayed in Step 3
4. **Done!** Your device is now registered for push notifications

## How It Works

```
                          ┌──────────────────────────────┐
┌────────────┐   ┌──────┐ │  plugin (127.0.0.1:4097)     │   ┌────────────┐
│   Phone    │──▶│Tunnel│▶│  /push-token   local         │   │  OpenCode  │
│  (browser  │   └──────┘ │  /tunnel       local         │   │   server   │
│   or app)  │            │  /__oc-mobile  overlay assets │   │   :4096    │
└────────────┘            │  /*            ──────────────┼──▶│            │
                          └──────────────────────────────┘   └────────────┘
```

1. **Tunnel**: Creates a secure public URL that your phone can reach. It points at
   the plugin, which forwards everything to OpenCode.
2. **QR Code**: Encodes the tunnel URL for easy scanning
3. **Push Token**: Your phone registers its Expo push token with the plugin
4. **Notifications**: OpenCode events trigger push notifications to your device
5. **Overlay**: HTML responses get a mobile stylesheet and session switcher injected
   on the way past. Everything else -- the REST API, the SSE event stream,
   WebSocket upgrades -- is forwarded byte for byte.

The tunnel client runs on your machine and dials loopback, so the plugin binds
`127.0.0.1` only and is never exposed on your LAN.

## Installing this fork

`npx opencode-mobile install` registers the **npm package**, which is upstream.
It will not give you the mobile overlay. To run this fork, point OpenCode at your
local checkout instead.

```bash
# 1. Get the code and build it. The plugin's entry point is dist/index.js, so
#    the build is required -- OpenCode loads the compiled output, not the source.
git clone https://github.com/jcrock7/opencode-mobile
cd opencode-mobile
npm ci          # or `npm install`
npm run build

# 2. Register it in your global OpenCode config as a file:// spec.
#    Use the absolute path to the checkout.
$EDITOR ~/.config/opencode/opencode.json
```

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["file:///absolute/path/to/opencode-mobile"]
}
```

There is a ready-made copy of this at [`examples/opencode.json`](examples/opencode.json)
(and a commented [`examples/opencode.jsonc`](examples/opencode.jsonc)).

To skip editing the path by hand, let the repo resolve it:

```bash
npm run print-config              # print it, merged over your existing settings
npm run print-config -- --merge    # write it to ~/.config/opencode/ (backs up first)
```

`--merge` preserves your other settings and plugins, drops a stale
`opencode-mobile@latest` entry, refuses to touch a config it cannot parse, and is
safe to run twice.

If you edit by hand instead: the path must be **absolute**, and if you already
have `"opencode-mobile@latest"` in that array, **replace** it -- running both
loads two copies of the plugin and they will contend for the same port.

Node 18 or newer is enough to build. The plugin itself runs under Bun inside
OpenCode, so its runtime does not depend on your Node version -- but the test
suite needs Node 20 or newer, because vitest 4 requires it.

If you cloned before the dependency cleanup and `npm install` fails on
`cloudflared`'s postinstall with `Text file busy` (exit code 126), see
[Install fails on cloudflared](#install-fails-on-cloudflared).

The `/mobile` command is optional -- the QR code is printed automatically when
the tunnel starts. If you want the command anyway, note that the installer has no
flag to add *only* it: `install` always writes `opencode-mobile@latest` into the
plugin array as well. So run it first, then point the config at your fork:

```bash
# optional: writes ~/.config/opencode/commands/mobile.md
# (also adds the npm spec, which step 2 above then replaces)
node bin/audit install --skip-tunnel-setup --skip-update-check
```

Use `--dry-run` first if you want to see what it would change.

```bash
# 3. Start OpenCode in serve mode. The plugin's server and tunnel only start
#    when the `serve` subcommand is present -- plain `opencode` and
#    `opencode attach` deliberately skip them.
export OPENCODE_SERVER_PASSWORD='a-long-random-string'   # see Securing the tunnel
opencode serve
```

On startup you should see the plugin announce its version and its routes:

```
[opencode-mobile] v1.4.0
[Push] Server running on 127.0.0.1:4097
[Push] /__oc-mobile/overlay.css → mobile overlay stylesheet
[Push] /__oc-mobile/overlay.js → session switcher
[Push] /* → OpenCode on port 4096 (HTML gets the overlay)
[Tunnel] Cloudflare started: https://<something>.trycloudflare.com
```

The version line is a useful check: `v1.4.0` means the built `dist/` copy loaded.
`vunknown` means OpenCode picked up the TypeScript source directly, which is fine
in development but means you are not running what `npm run build` produced.

### Using it

Open the tunnel URL in Safari and add it to your Home Screen -- OpenCode's web UI
already ships the PWA manifest, so it runs standalone. The overlay applies
automatically at 767px and below.

Type `/mobile` inside OpenCode to print the QR code for the tunnel URL, or to
register a push token.

### Updating after a code change

```bash
git pull
npm run build
# restart `opencode serve`
```

The overlay assets are revalidated rather than fingerprinted, so hard-reload the
page on your phone after an upgrade if it looks stale.

### A note on runtimes

OpenCode runs on Bun, and so does this plugin. The compiled output uses
extensionless relative imports, which Bun resolves and Node's ESM loader does
not -- so `node dist/index.js` fails while `bun dist/index.js` works. That is
expected; it only matters if you try to smoke-test the build with Node.

## Mobile web overlay

If you browse to the tunnel URL on your phone, you get OpenCode's own web UI. It is
a desktop-designed app: the session timeline has no viewport media queries, so file
names and command lines truncate mid-word, prose renders at 14px, and code blocks
squeeze rather than scroll.

The plugin fixes that without forking OpenCode. Because the tunnel now points at the
plugin, it can inject a mobile stylesheet into the HTML on its way to your phone.

**What the overlay does**

- Un-truncates the timeline slots that ellipsise file names, directories, tool
  subtitles and patch targets, so you can read what the agent is doing
- Raises prose to 16px with a comfortable line height
- Makes code, diffs and tool output scroll horizontally in their own box instead of
  wrapping (a wrapped diff loses its +/- alignment)
- Restores the timeline scrollbar, so you can tell where you are in a long session
- Adds a **now-running status bar** pinned above the composer, saying what the
  agent is doing at this moment: the tool, its title, and how long it has been
  going. Copper when a permission is waiting on you, red when the session failed,
  gone when it is idle. This is the one thing a phone screen cannot otherwise tell
  you without scrolling to hunt for the live tool row.
- Adds a **session switcher**: a horizontally scrolling strip of chips above the
  timeline, one per session, coloured by state and sorted so anything needing you
  comes first
- **Handles PWA safe areas.** Installed to the Home Screen the page runs with no
  browser chrome, and OpenCode asks for a translucent status bar with
  `viewport-fit=cover` -- so the document extends *under* the notch and the home
  indicator. Which padding is the overlay's to add depends on the layout, and
  upstream ships two. The v2 layout (`layout-new.tsx`, the one with the Session /
  Changes tabs) already applies both vertical insets to its own root, so padding
  the app shell as well applies them *twice* -- roughly 118px of dead black above
  the titlebar on a Dynamic Island phone, and about 68px under the composer. So
  the vertical inset is gated on a marker only the legacy layout renders, while
  the horizontal inset, which neither layout sets, is unconditional.
- **Enforces 44pt hit areas** on the chrome controls, which are built for a
  mouse: upstream's icon buttons are 20/24/28px square, its labelled buttons
  24/28/32px tall, and the Session / Changes switcher 28px. Two details make the
  difference between a rule that works and one that does nothing. The icon
  buttons set an explicit *square* size, so they need a `min-width` floor as well
  as a `min-height` -- height alone yields a tall thin sliver. And upstream ships
  two generations of nearly every control; the phone build renders the `-v2` set,
  so those selectors are listed alongside their v1 namesakes. The titlebar is
  released from its fixed 40px `overflow: hidden` box at the same time, or it
  simply clips the taller buttons. Glyphs go to 20px so the bigger buttons are
  not mostly empty -- scoped to direct icon children, so the progress spinner and
  the file-type badges keep the sizes they were given. All of it sits behind the
  phone breakpoint.
- **Keeps the software keyboard from pushing the layout off screen.** Installed
  to the Home Screen, OpenCode sets `#root { height: 100vh }` -- deliberately,
  because WebKit excludes the safe-area insets from `dvh` in an installed app.
  But `100vh` is the *layout* viewport, and iOS does not shrink that when the
  keyboard opens: it shrinks only the visual viewport, then scrolls the document
  to bring the focused field into view. Two symptoms, one cause -- that scroll
  drags the top of the shell, safe-area padding and all, above the visible area
  so the timeline runs under the clock; and the shell still believes it is full
  height, so the composer sits adrift of the keyboard instead of resting on it.
  The overlay pins the shell to `visualViewport.height` and undoes the scroll.
  There is no CSS unit for this on iOS: `dvh` tracks browser chrome rather than
  the keyboard, `env(keyboard-inset-*)` needs the VirtualKeyboard API that
  WebKit does not implement, and the `interactive-widget=resizes-content` the
  viewport meta already asks for is ignored. Only applies while installed and
  only at phone widths -- in a browser tab Safari's own toolbar moves the visual
  viewport for reasons that have nothing to do with the keyboard. Switch off
  with `OPENCODE_MOBILE_OVERLAY_KEYBOARD=0`.
- **Collapses the home-indicator inset while the keyboard is up.** Pinning the
  shell fixed the layout but left a blank band above the keyboard, because iOS
  never zeroes `env(safe-area-inset-bottom)` for the keyboard -- the insets
  describe the *device*, not whatever happens to be covering it. So the v2
  layout kept reserving a strip for a home indicator the keyboard was sitting on
  top of, and the overlay's own dock padding added a little more. With the
  keyboard open there is no home indicator to avoid, so the script marks the
  shell `data-oc-keyboard="open"` and both collapse.
- **Reports what it measured**, with `OPENCODE_MOBILE_OVERLAY_DEBUG=1`: a strip
  at the top of the phone showing whether the keyboard is detected, the visual
  viewport against the layout viewport, the height that got pinned, the bottom
  inset iOS is actually claiming, and the scroll offsets. Two rounds of this
  were diagnosed by measuring gaps off a screenshot in pixels, which is slow and
  picks the wrong answer when two explanations predict a similar gap.
- **Separates your message from the answer.** Upstream renders your prompt, the
  agent's prose and every tool row at the same weight, in the same colour, down
  the same full-width column -- on a phone that reads as one wall of text, where
  a shell command looks exactly like a sentence. Three tiers instead:
  **your message** keeps upstream's own bubble -- which already exists, right
  aligned, on `[data-slot="user-message-text"]` -- and gains a tail corner, a
  hairline so it separates from a black background, and a width cap. The tail is
  an asymmetric `border-radius` rather than a pseudo-element triangle, which
  would have to know the bubble's background and break on a theme change.
  Styling upstream's bubble rather than adding one matters: an earlier version
  boxed the whole row and produced a bubble inside a bubble. **The response**
  stays full width, because prose,
  code and diffs all need the room, but gains a rail down its left edge so the
  whole answer reads as one channel; **tool rows** are demoted to a subdued card
  so the eye can skip them when reading and find them when scanning. Errors and
  retries get a red rail; nothing else is coloured. All of it uses upstream's own
  `--v2-*` theme tokens, so it follows the light and dark themes rather than
  guessing. Off with `OPENCODE_MOBILE_OVERLAY_BUBBLES=0`.

  The rail is a `border-left` on each assistant row rather than one border on a
  container, because no element wraps a whole response. It works because the row
  frame carries its own `pt-3` between consecutive assistant parts, so the
  borders butt into a continuous line -- and normal turns are separated by a
  `TurnGap` row, which has no border, so the rail breaks exactly at the turn.
- **Trades the Session / Changes tab bar for a titlebar button.** That bar is a
  permanent row above the timeline -- 44px once its touch targets are honoured --
  spent on a control used occasionally, on the axis a phone has least of. The
  overlay hides it and puts both actions on one button in the titlebar: a
  GitHub mark to open the diff view, badged with the changed-file count, and an
  ✕ in the same place to come back. Off with
  `OPENCODE_MOBILE_OVERLAY_CHANGES=0`, which restores the bar.

  The button clicks upstream's own tab triggers rather than reimplementing the
  switch, and that is deliberate: `mobileTab` is local component state in
  `session.tsx`, not a route or a query param, so the triggers are the only
  handle on it -- and driving the real control leaves the panel, its scroll
  position and its keyboard handling entirely upstream's. The bar is hidden with
  `display: none` on the list, which keeps those triggers in the DOM and
  clickable. The count is read as digits out of the tab's own label, so it
  survives translation where matching the words would not, and the button
  follows the tab changing by other means (opening a review comment switches
  it) through a `MutationObserver` on the triggers' selected state.
- **Surfaces sub-agent work.** Child sessions are what a sub-agent runs in, and
  they used to show nowhere at all on a phone: not in the strip (excluded by
  design) and not in notifications (suppressed by design). The status bar was
  the worst of it -- while a sub-agent worked, the parent was busy with no tool
  of its own, so the bar said only "Working" and the delegated work was
  invisible. A sub-agent's running tool now reports on its parent's bar, named
  as one (`sub-agent · grep · callers of migrate()`), and the parent's chip
  carries a `+2` badge counting its busy children. Deliberately *not* chips of
  their own: several sub-agents can run at once and each is transient, so their
  chips would push the sessions you navigate by off the end of the strip. This
  also fixed a latent bug -- the running tool was tracked in a single global, so
  a tool starting in any session relabelled the bar for the one you were looking
  at. It is now keyed per session.
- **Grows the project and session rows in the drawer**, the list you actually
  pick a session from. Upstream sizes them for a mouse -- a project row is 28px,
  a session row 40px -- and each carries absolutely-positioned trailing actions
  (a menu, an edit button) which the touch-target rule above had already grown
  to 44px. Inside a 28px row those overflowed 8px onto the rows above and below,
  so a tap near a row edge could hit the wrong row's pencil; growing the rows
  fixes the target size and that overflow together. Each row's wrapper grows in
  the same rule, both because a fixed-height wrapper would otherwise clip its
  own button and because a selector list is not forgiving -- where `:has()` is
  unavailable the whole rule drops, which is the safe way to fail. The search
  field and the sticky group headers are deliberately untouched: their geometry
  is hand-tuned pixel offsets derived from the search box's height, so growing
  it would misalign every sticky header in the list.
- **Grows the composer's tap areas without growing its boxes.** The composer's
  control row is the one place a size floor does harm: it is a fixed 44px box
  holding the attach, model, variant and send controls on a single line, inside a
  form with `overflow-clip`. Forcing 44px boxes there pushed the send button out
  of its slot and painted it over the variant control. Inside the composer the
  rendered boxes stay at upstream's size and the tap area is grown with an inset
  pseudo-element instead -- 44pt of touch, zero layout change.
- Contains overscroll to the timeline, so it stops rubber-banding the whole page
- Removes the tap-highlight flash and text cursor from chrome, while keeping
  prose, code and diffs selectable -- copying a path out of a session is the point
- Trims titlebar and tab padding, which on a 390x844 screen were part of a chrome
  stack eating roughly a third of the height before any content appeared

**Where the status bar gets its facts**

`message.part.updated` on the SSE stream carries the tool part: its `tool` name,
`state.status`, `state.title` and `state.time.start`. That is the only event that
says *what* is running rather than merely that something is -- `/session/status`
gives only busy/idle/retry -- so the bar reads it and shows e.g. `bash · npm test`
with a counter from the tool's own start time. It shares the single `EventSource`
the session strip already opens rather than adding a second.

**Session states**

| Colour | State | Meaning |
|--------|-------|---------|
| teal | working | A tool call is open |
| copper | needs you | Blocked on a permission prompt; sorts first |
| red | failed | The session errored |
| grey | idle | Finished, waiting on you |

These are the same four states the plugin's push notifications use.

**Turning it off**

```bash
# transparent proxy: forward everything, inject nothing
OPENCODE_MOBILE_OVERLAY=0 opencode serve

# keep the stylesheet, drop the session switcher
OPENCODE_MOBILE_OVERLAY_STRIP=0 opencode serve

# treat wider screens as mobile too (e.g. an iPad in portrait)
OPENCODE_MOBILE_OVERLAY_MAX_WIDTH=1024 opencode serve
```

**How the injection works**

OpenCode serves its UI under a strict Content Security Policy. The overlay is built
to fit inside it rather than around it:

- `style-src 'self' 'unsafe-inline'` permits the injected `<link>`
- `script-src 'self'` permits the injected `<script src>` because the plugin serves
  it from the same origin

The CSP header is forwarded verbatim -- it contains a hash of OpenCode's own
theme-preload script, so recomputing it would break the page and dropping it would
weaken it. Only `text/html` responses are ever buffered and rewritten; the event
stream, API responses and WebSocket upgrades pass through untouched.

The overlay's rules use `!important` deliberately. OpenCode's own rules are
CSS-nested (so higher specificity than a flat selector) and its stylesheet is
injected at runtime by the app bundle, so neither specificity nor document order
would reliably win.

The overlay targets `data-component` / `data-slot` attributes. If a future OpenCode
release renames one, that rule stops applying -- it does not break the page.

## The settings screen on a phone

Upstream's settings dialog is built for a desktop, and three of its own
measurements make it painful at 393pt. All three are fixed behind the phone
breakpoint:

| Upstream | Consequence | Overlay |
|---|---|---|
| `dialog-v2.css`: x-large is `height: min(100vh - 92px, 600px)` | On an 852pt phone the dialog stops at 600pt and floats in a band of dead space | Full screen, square corners, padded for the insets itself -- it is portalled outside the app shell, so the padding on `#root` never reaches it |
| `tabs.css`: the settings tab list is `min-width: 150px` | Of a 361pt dialog that leaves ~200pt of content, so every description wraps after two or three words | 112px, which these five labels fit comfortably |
| `settings-v2.css`: 40px side gutters on the header and body | Another 80pt out of that 200 | 16px |

Nothing is restructured. Flipping the vertical tabs into a horizontal strip
would be the better phone pattern, but the list wraps its groups in Tailwind
`flex-col` divs, and fighting those with `!important` is far more brittle than
making the existing columns fit. The rows themselves already wrap their control
onto its own line below 640px upstream, so they only needed the touch target.

## Progress notifications

Four kinds of notification existed before this: a completion, an error, and the
two permission prompts. All four fire when the agent has **stopped**. Nothing
told you work was underway, so a long run looked exactly like a dead tunnel
until it finished.

The obvious fix -- notify when a session starts working -- roughly doubles the
volume and most of what it adds is worthless: a turn that finishes in eight
seconds does not need a "started" push followed a moment later by a "finished"
one. So this is **not** a start notification. A timer is armed when the session
goes busy and **cancelled if the session settles first**. Only work that
outlives the delay ever notifies, which is precisely the work you cannot
otherwise tell is happening.

```
Agent finished the task          <- session.idle      (existing)
miser still working              <- session.progress  (new)
  bash · npm test -- running 1m 30s
```

Details that matter:

- **One notification per busy period.** No repeats. A ping every minute through
  an hour-long run is the noise this is trying to avoid, and the completion
  notification still closes the loop.
- **It names the work.** The running tool arrives on `message.part.updated`,
  which is far too frequent to notify on but cheap to record. Whatever was
  running when the timer fires goes in the body, so the notification says what
  is happening rather than only that something is.
- **Sub-agents are attributed to their parent.** A bare child session id means
  nothing to you, so a sub-agent's tool is reported against the session you
  started, labelled `sub-agent · ...`. A sub-agent's own session never gets its
  own notification -- children are suppressed globally, and a test asserts the
  progress kind is not the one that leaks them.
- **It is quiet.** Normal priority, no sound. An update on work you already know
  you started should be there when you look, not demand that you look.
- **The timers are `unref`'d**, so a pending one can never be the reason
  OpenCode takes an extra minute to exit.

Off with `OPENCODE_MOBILE_PROGRESS=0`; retimed with
`OPENCODE_MOBILE_PROGRESS_AFTER=<seconds>`.

## Security fix: the plugin's own endpoints

**If you are running this fork with `OPENCODE_SERVER_PASSWORD` set, update.**

The plugin is a reverse proxy in front of OpenCode, and it answers three paths
itself -- `/push-token`, `/tunnel`, `/__oc-mobile/*` -- *before* the request
reaches OpenCode. `OPENCODE_SERVER_PASSWORD` therefore never covered them.
Anything that could reach the tunnel URL could reach them unauthenticated:

| Request | Effect |
|---|---|
| `POST /push-token` | Registers any device to receive this server's push notifications. Their bodies quote the agent's last message, so an attacker's phone receives your session output. |
| `DELETE /push-token` | Deregisters your real device. |
| `POST /tunnel` | Opens a **new public tunnel to a caller-chosen local port** and returns the new public URL in the response body. Not merely an auth bypass -- a way to publish any service on your loopback interface. |

A second vector reached the same endpoints without the tunnel at all: they
answered CORS preflights with `Access-Control-Allow-Origin: *`, so any web page
you visited could POST JSON to `http://127.0.0.1:<pluginPort>/tunnel`
cross-origin and read the reply.

Three changes:

1. **The plugin authenticates its own endpoints.** When
   `OPENCODE_SERVER_PASSWORD` is set, `/push-token` and `/tunnel` require the
   same HTTP Basic credentials, compared in constant time, answering `401` with
   a `WWW-Authenticate` challenge so the phone offers its saved credentials.
2. **`POST /tunnel` only accepts the two ports this process owns** (its own and
   OpenCode's). Enforced whether or not a password is set, because it is not an
   authentication question -- no caller has a legitimate reason to name another
   port.
3. **No wildcard CORS origin.** The consumer is the native app, which is not a
   browser and never enforced CORS, so the wildcard bought nothing.

With no password configured the endpoints stay open -- requiring credentials
nobody was told to set would lock out every existing install -- but startup now
warns, in those words, that they are reachable.

## Edge authentication (Cloudflare Access)

`OPENCODE_SERVER_PASSWORD` is a real control, but it is the *only* one: every
unauthenticated request still reaches your machine and gets to attempt auth, and
nothing in the stack rate-limits or locks out repeated guesses. The bigger win is
not a stronger credential -- it is moving the gate off your machine, so
unauthenticated traffic is rejected at Cloudflare's edge and never arrives.

This requires a **named** tunnel on a domain in your Cloudflare account. A free
`trycloudflare.com` URL cannot be protected this way.

**What to set up** (in Cloudflare Zero Trust, `one.dash.cloudflare.com`):

1. Add a **self-hosted application** whose public hostname is the one your named
   tunnel already serves.
2. Attach an **Allow policy** scoped to your own identity -- an `Emails` selector
   with just your address, not `Everyone`.
3. Choose a **login method**. One-time PIN by email needs no other setup. For
   passkeys, add an identity provider that enforces them (Google, GitHub and
   Microsoft Entra all support passkeys) and let Access federate to it -- Access
   does not implement WebAuthn itself, so passkeys come from the IdP.
4. Set the **session duration** long (see the PWA note below).
5. If anything non-browser needs in -- the mobile app registering a push token --
   create a **service token** and a policy that accepts it. Service tokens
   authenticate with `CF-Access-Client-Id` and `CF-Access-Client-Secret`
   headers instead of a login redirect.

I have written these as the shape of the configuration rather than a click-path,
because Cloudflare's dashboard labels move: check the current
[Cloudflare One docs](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/self-hosted-public-app/)
for exact navigation. What the setup has to *achieve* is verifiable from here --
see the doctor check below.

**Verify it, do not assume it.** `npm run doctor` now has an edge-authentication
section that makes an **anonymous** request to your public URL -- deliberately
without the password -- and reports what an attacker holding only the URL
receives:

| What the doctor sees | Verdict |
|---|---|
| 302 to `<team>.cloudflareaccess.com` | `ok` -- Access is enforcing |
| `/cdn-cgi/access/certs` answers but `/` does not redirect | `warn` -- Access knows the hostname but a policy is set to Bypass, or a path exclusion covers `/` |
| 401 from OpenCode | `warn` -- no edge gate; the password is the only thing protecting you |
| 200 | `FAIL` -- anyone with the URL has your server |

**Three things worth knowing before you turn it on:**

- **Keep `OPENCODE_SERVER_PASSWORD` set.** Access protects the *hostname*, not
  this process. If the policy is removed, the app is set to Bypass, or the port
  is ever exposed another way, the origin is otherwise naked. The doctor warns
  when Access is enforcing but the password is unset.
- **Set a long session duration.** A Home Screen PWA whose Access session has
  expired receives a cross-origin redirect to `cloudflareaccess.com`, which does
  not re-authenticate gracefully inside a standalone web app -- you get a
  browser hand-off rather than a login inside the PWA.
- **The event stream dies with the session.** The overlay's `EventSource` is
  same-origin and carries the `CF_Authorization` cookie, so it works once you
  are logged in. When the session expires mid-use, the stream gets redirected
  and the overlay's reconnect backoff will not recover it until you reload and
  re-authenticate. The session bar going stale is the symptom.

## Securing the tunnel

**A tunnel publishes a server that can run shell commands in your working tree.**
Anyone who learns the URL has your machine.

OpenCode supports HTTP Basic auth, and warns on startup when it is not set:

```
Warning: OPENCODE_SERVER_PASSWORD is not set; server is unsecured.
```

Set it before exposing a tunnel:

```bash
export OPENCODE_SERVER_PASSWORD='a-long-random-string'
opencode serve
```

The username defaults to `opencode` (override with `OPENCODE_SERVER_USERNAME`).
Safari will prompt once and offer to save it in your Keychain. The plugin forwards
the `Authorization` header unchanged, so the overlay, the assets and the proxied API
are all covered by the same credential.

## Available Commands

| Command | Description |
|---------|-------------|
| `npx opencode-mobile install [options]` | Install plugin and `/mobile` command globally |
| `npx opencode-mobile update [--check]` | Check for updates or install the latest version |
| `npx opencode-mobile filters <status\|enable\|disable>` | Manage session notification filters |
| `npm run doctor` | Diagnose the chain end to end: plugin registration, build, running instances, local servers, tunnel target, public URL, and whether anything authenticates at the edge |
| `npm run print-config` | Print the global config to load this checkout as a plugin |
| `npm run print-config -- --merge` | Write that config to `~/.config/opencode/` |
| `/mobile` | Display QR code for mobile connection |
| `/mobile ExponentPushToken[xxx]` | Manually register a push token |
| `npx opencode-mobile qr <tunnels.json>` | Show QR from tunnel metadata JSON |
| `npx opencode-mobile-tunnel-setup [options]` | Configure tunnel provider interactively or non-interactively |
| `npx opencode-mobile audit` | Run endpoint audit |
| `npx opencode-mobile uninstall` | Remove plugin globally |

## Configuration

### Requirements

- Node 18+ to build. The plugin runs under Bun inside OpenCode, so its runtime is
  independent of your Node version; the test suite needs Node 20+ (vitest 4).
- `cloudflared`, `ngrok`, or nothing (localtunnel needs no binary). Install the
  tunnel binary with your system package manager -- the plugin looks for it on
  your PATH and in the usual locations, and does not ship one.

### Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `TUNNEL_PROVIDER` | Tunnel provider (`auto`, `ngrok`, `cloudflare`, `localtunnel`) | `auto` |
| `OPENCODE_MOBILE_DEBUG` | Enable debug logging (`1` to enable) | disabled |
| `OPENCODE_PORT` | Local server port | `3000` |
| `OPENCODE_MOBILE_OVERLAY` | Mobile web overlay. `0` makes the plugin a transparent proxy | enabled |
| `OPENCODE_MOBILE_OVERLAY_STRIP` | Session switcher strip. `0` disables it | enabled |
| `OPENCODE_MOBILE_OVERLAY_STATUS` | "Now running" status bar. `0` disables it | enabled |
| `OPENCODE_MOBILE_OVERLAY_CHANGES` | Replace the Session / Changes tab bar with a button in the titlebar. `0` restores the tab bar | enabled |
| `OPENCODE_MOBILE_OVERLAY_BUBBLES` | Three visual tiers in the transcript: your message as a bubble, the response railed, tool rows demoted. `0` disables it | enabled |
| `OPENCODE_MOBILE_OVERLAY_KEYBOARD` | Pin the shell to the visual viewport so the keyboard cannot push the layout off screen. `0` disables it | enabled |
| `OPENCODE_MOBILE_OVERLAY_MAX_WIDTH` | Viewport width (px) at or below which the mobile rules apply | `767` |
| `OPENCODE_MOBILE_OVERLAY_DEBUG` | `1` shows a badge on the page proving the overlay is applied | off |
| `OPENCODE_MOBILE_PROGRESS` | Progress notification for work that outlives the delay below. `0` disables it | enabled |
| `OPENCODE_MOBILE_PROGRESS_AFTER` | Seconds a session must stay busy before it is worth notifying about. Accepts 5-3600; anything else is treated as a typo and ignored | `60` |
| `OPENCODE_SERVER_PASSWORD` | **OpenCode's own** HTTP Basic password. Not read by this plugin, but see [Securing the tunnel](#securing-the-tunnel) | unset |

### Tunnel Providers

The plugin automatically tries providers in this order:

1. **Cloudflare** - Recommended, secure default
2. **ngrok** - Popular tunnel service (requires auth token)
3. **Localtunnel** - Simple, free tunnel option

### Automated/CI Install Examples

```bash
# Non-interactive install using Cloudflare
npx opencode-mobile install --yes --provider cloudflare

# Skip update checks in CI
npx opencode-mobile install --yes --provider cloudflare --skip-update-check

# Non-interactive ngrok setup
npx opencode-mobile install --yes --provider ngrok --ngrok-authtoken YOUR_TOKEN
```

### Installing ngrok (Optional)

For the best experience with stable URLs:

```bash
# macOS
brew install ngrok

# Get your authtoken from https://dashboard.ngrok.com
ngrok config add-authtoken YOUR_TOKEN
```

## Troubleshooting

### "No tunnel URL found"

**Problem**: Tunnel failed to start

**Solutions:**
```bash
# Check tunnel provider is installed
command -v ngrok
command -v cloudflared

# Run tunnel setup manually
npx opencode-mobile-tunnel-setup

# Or skip tunnel setup during install
npx opencode-mobile install --skip-tunnel-setup
```

### "Push token not registering"

**Problem**: Device can't reach the plugin server

**Solutions:**
- Ensure your phone and computer are on the same network (for LAN mode)
- Check that the tunnel URL is accessible from your phone's browser
- Verify the QR code scanned correctly (compare the URL)

### Plugin not loading

**Problem**: OpenCode doesn't recognize the plugin

**Solutions:**
```bash
# Verify installation
npx opencode-mobile --help

# Check global config
cat ~/.config/opencode/opencode.json

# Reinstall
npx opencode-mobile uninstall --yes
npx opencode-mobile install
```

### The plugin does not start with `opencode serve`

`opencode serve` starts the HTTP server but loads **no plugins**. Plugins are
instance-scoped, and serve is declared `instance: false` -- it creates an instance
per request, keyed by the `?directory=` query parameter or the
`x-opencode-directory` header. Until something makes a request, there is no
instance, so there is no plugin: nothing on port 4097, no tunnel, and no
`[opencode-mobile] v...` banner.

Leave the server running and poke it once from another terminal:

```bash
curl -su opencode:"$OPENCODE_SERVER_PASSWORD" \
  "http://127.0.0.1:4096/session?directory=$HOME/your/project" \
  -o /dev/null -w '%{http_code}\n'
```

The serve output should then print the plugin banner and its routes, and start the
tunnel. Loading the web UI and opening a project has the same effect.

Note also that `npm run doctor` probes live ports -- run it in a second terminal
while the server is up, not after stopping it.

### Install fails on cloudflared

**Problem**: `npm install` ends with

```
npm ERR! code 126
npm ERR! path .../node_modules/cloudflared
npm ERR! command sh -c node scripts/postinstall.js && node lib/index.js -v
npm ERR! Installed cloudflared to .../node_modules/cloudflared/bin/cloudflared
npm ERR! /bin/sh: 1: .../node_modules/cloudflared/bin/cloudflared: Text file busy
```

The `cloudflared` npm package downloads a binary in its postinstall and then
execs it to check the version. `Text file busy` (ETXTBSY) means the file was
still held open when it tried -- most often because a `cloudflared` process
started from that same path is still running.

**That package is no longer a dependency.** The plugin never imported it: it
locates `cloudflared` on your PATH and in the usual install locations
(`/opt/homebrew/bin`, `/usr/local/bin`, `/usr/bin`, `~/.cloudflared`, linuxbrew),
or at whatever path tunnel setup saved. Pull and reinstall:

```bash
git pull
rm -rf node_modules
npm ci
```

On an older checkout, either stop any running `opencode serve` / `cloudflared`
first and retry, or install with `npm install --ignore-scripts` -- the downloaded
binary is unused either way.

Install `cloudflared` itself with your system package manager (`brew install
cloudflared`, or Cloudflare's apt/yum repo), not through npm.

### Is the overlay actually applied?

Most of what the overlay changes is either subtle (14px prose to 16px) or only
visible on tool-call rows -- so a session showing nothing but assistant prose can
look identical either way. iOS has no dev tools to check with, so:

```bash
OPENCODE_MOBILE_OVERLAY_DEBUG=1 opencode serve
```

A small teal badge appears at the bottom-left of the page whenever the overlay is
in scope. If you see it, the stylesheet is loaded and the breakpoint matches. It
is `pointer-events: none`, so it cannot swallow a tap.

You can also load the stylesheet directly on the phone to prove the asset
reaches the device: browse to `https://your-tunnel-url/__oc-mobile/overlay.css`
and you should get CSS text rather than a 404.

**Where the difference actually shows.** The truncation fixes apply to tool-call
rows -- file names, directories, tool subtitles, patch targets. Those are folded
shut by default, so turn on Settings -> General -> *Expand shell tool parts* and
*Expand edit tool parts*, then scroll back through a session with real tool calls
in it.

### Overlay not appearing: run the doctor first

```bash
npm run doctor
```

It walks the whole chain in order -- plugin registered, build current, OpenCode
listening, plugin listening, overlay served and injected, tunnel pointing at the
plugin rather than at OpenCode, public URL serving it -- and names the first
thing that is wrong. It is read-only and prints no secrets.

The three causes it most often finds:

| Symptom | Cause |
|---|---|
| `only the upstream npm package is registered` | Your config still says `opencode-mobile@latest`. That package has no overlay. Fix with `npm run print-config -- --merge`. |
| `nothing answering on 127.0.0.1:4097` | The plugin never started -- usually because OpenCode was launched without the `serve` subcommand. |
| `tunnel points straight at OpenCode (4096), bypassing the plugin` | A tunnel you run yourself (or a systemd service, or a saved named tunnel) forwards to 4096. The plugin cannot move it; repoint it at 4097. |

### Overlay not appearing on the phone

**Problem**: The page loads but still looks like the desktop UI

**Solutions:**
```bash
# 1. Confirm the tunnel points at the plugin, not OpenCode directly.
#    On startup the plugin logs its routes:
#      [Push] /* -> OpenCode on port 4096 (HTML gets the overlay)

# 2. Confirm the assets are reachable through the tunnel
curl -sI https://your-tunnel-url/__oc-mobile/overlay.css | head -1   # expect 200
curl -s  https://your-tunnel-url/ | grep oc-mobile-overlay          # expect the <link>

# 3. The overlay only applies at or below the breakpoint (767px by default).
#    On an iPad or in a wide window, raise it:
OPENCODE_MOBILE_OVERLAY_MAX_WIDTH=1024 opencode serve
```

Hard-reload in Safari after an upgrade: the assets are revalidated rather than
fingerprinted, so a suspended tab can hold an old copy.

### Session switcher is missing

The strip hides itself when there are fewer than two parent sessions -- one session
is not a switcher. Child (sub-agent) sessions are excluded by design, matching how
notifications treat them.

### Reset Everything

```bash
# Uninstall plugin
npx opencode-mobile uninstall --yes

# Clear stored tokens
rm ~/.config/opencode/mobile-tokens.json

# Reinstall
npx opencode-mobile install
```

## Project Structure

```
opencode-mobile/
├── index.ts              # Main plugin entry point (server + routing)
├── examples/            # Global OpenCode config to copy (see examples/README.md)
├── scripts/             # print-config and doctor helpers
├── src/
│   ├── tunnel/          # Tunnel providers (ngrok, cloudflare, localtunnel)
│   ├── push/            # Push notification logic
│   ├── proxy/           # Reverse proxy to OpenCode + request routing
│   ├── overlay/         # Mobile web overlay (CSS, session switcher, injection)
│   └── cli/             # CLI commands (install, qr, audit, etc.)
├── bin/                 # CLI entry points
├── dist/                # Compiled output
└── package.json
```

## Contributing

See [AGENTS.md](./AGENTS.md) for development guidelines and project structure.

## License

MIT License - see [LICENSE](LICENSE) file for details.
