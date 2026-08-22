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
- Test suite grown to 447 tests with an enforced 85% coverage threshold
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

If you already have `"opencode-mobile@latest"` in that array, replace it --
running both loads two copies of the plugin and they will fight over the port.

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
- Enforces 44px touch targets on the accordion triggers
- Hides the fixed 64px sidebar rail, which duplicates the drawer below 1280px
- Pads the composer for the home indicator
- Adds a **session switcher**: a horizontally scrolling strip of chips above the
  timeline, one per session, coloured by state and sorted so anything needing you
  comes first

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
| `OPENCODE_MOBILE_OVERLAY_STRIP` | Session switcher strip. `0` keeps the CSS, drops the script | enabled |
| `OPENCODE_MOBILE_OVERLAY_MAX_WIDTH` | Viewport width (px) at or below which the mobile rules apply | `767` |
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
