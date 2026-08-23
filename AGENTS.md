# AGENTS.md

## Overview

`opencode-mobile` - Single mobile push notification plugin for OpenCode. Enables push notifications via Expo for mobile devices with tunnel management (ngrok/cloudflare/localtunnel). Built with TypeScript and Bun runtime.

## Build, Lint, and Test Commands

```bash
# Run the plugin
bun run index.ts

# Type-check only (no emit)
npm run typecheck
npx tsc --noEmit

# Compile TypeScript
npx tsc

# Build (type-check + compile)
npm run build

# Testing with vitest
npx vitest run                    # Run all tests
npx vitest run --coverage         # Run with coverage (85% threshold, enforced)
npx vitest run src/tunnel/        # Run tunnel tests
npx vitest run src/tunnel/localtunnel.test.ts  # Run specific test file
npx vitest run --reporter=verbose # Verbose output
npx vitest ui                     # Interactive UI (http://localhost:51204/__vitest__)

# Opt-in live suites (need real credentials / network)
OPENCODE_TEST_NGROK_LIVE=1 npx vitest run src/tunnel/ngrok.test.ts

# Version and release
npm version patch && npm run build && npm publish  # Patch release
```

## Project Structure

```
plugin/
├── index.ts              # Entry point (plugin + HTTP server)
├── src/
│   ├── tunnel/           # Tunnel providers (ngrok, cloudflare, localtunnel)
│   │   ├── index.ts      # Unified interface, orchestrator
│   │   ├── localtunnel.ts# Localtunnel provider (62 lines, testable)
│   │   ├── cloudflare.ts # Cloudflare tunnel (117 lines, testable)
│   │   ├── ngrok.ts      # Ngrok with 4-strategy fallback (480 lines)
│   │   ├── qrcode.ts     # QR code utilities
│   │   ├── types.ts      # Type definitions
│   │   ├── *.test.ts     # Unit tests (vitest)
│   │   └── vitest.config.ts
│   ├── push/             # Push notification logic
│   │   ├── index.ts      # Barrel export
│   │   ├── types.ts      # Push types
│   │   ├── token-store.ts# Token persistence
│   │   ├── formatter.ts  # Notification formatting
│   │   ├── sender.ts     # Expo API sender
│   │   └── notification-handler.ts  # Session notification (commented)
│   ├── proxy/            # Reverse proxy to OpenCode
│   │   ├── forward.ts    # Streaming proxy + HTML rewrite hook + upgrades
│   │   ├── route.ts      # Pure request routing (pure -> testable)
│   │   └── *.test.ts     # Integration tests against real http servers
│   └── overlay/          # Mobile web overlay injected into OpenCode's UI
│       ├── config.ts     # Env-driven config + asset route constants
│       ├── inject.ts     # Pure HTML tag injection (idempotent)
│       ├── mobile-css.ts # The injected stylesheet
│       ├── mobile-js.ts  # The injected session switcher
│       ├── serve.ts      # Asset serving (content types, ETag, 304)
│       └── *.test.ts     # Unit tests (vitest)
├── vitest.config.ts      # Test configuration
├── tsconfig.json         # TypeScript config (strict mode, bundler)
└── package.json          # Dependencies + scripts
```

## Code Style Guidelines

### Imports

```typescript
// Standard library - namespace imports
import * as fs from "fs";
import * as path from "path";

// External modules - named or default imports
import ngrok from "@ngrok/ngrok";
import qrcode from "qrcode";

// Types - use import type when only using types
import type { Plugin } from "@opencode-ai/plugin";
import type { TunnelConfig } from "./types";

// Group imports logically: types → external modules → internal modules
import type { Plugin } from "@opencode-ai/plugin";
import * as fs from "fs";
import * as path from "path";
import { startTunnel } from "./src/tunnel";
```

### Formatting

- **2 spaces** for indentation
- **Single quotes** for strings
ons** at end- **Semicol of statements
- **Trailing commas** in multi-line objects/arrays
- **Max line length**: ~100 characters (soft limit)

### Types

```typescript
// Interfaces for object shapes
interface PushToken {
  token: string;
  platform: "ios" | "android";
  deviceId: string;
  registeredAt: string;
}

// Type aliases for unions/primitives
type NotificationHandler = (notification: Notification) => Promise<void>;

// Explicit return types for public functions
function loadTokens(): PushToken[] {
  // ...
}

// Avoid `any` - use `unknown` with type guards when uncertain
function safeParse(data: unknown): Record<string, unknown> {
  if (typeof data === "string") {
    try {
      return JSON.parse(data);
    } catch {
      return {};
    }
  }
  return data as Record<string, unknown>;
}
```

### Naming Conventions

| Pattern | Convention | Example |
|---------|------------|---------|
| Constants | UPPER_SNAKE_CASE | `TOKEN_FILE`, `BUN_SERVER_PORT` |
| Functions/variables | camelCase | `loadTokens`, `startTunnel` |
| Interfaces/classes | PascalCase | `PushToken`, `TunnelConfig` |
| Private/internal | prefix `_` | `_bunServer`, `_pluginInitialized` |
| Booleans | prefix `is`, `has`, `should` | `isRunning`, `hasStarted` |

### Error Handling

```typescript
// Always wrap async operations in try-catch
try {
  await someAsyncOperation();
} catch (error: unknown) {
  // Log errors with module prefix
  console.error("[ModuleName] Error message:", error.message);
  
  // Provide context in error messages
  if (error.message?.includes("specific case")) {
    console.error("[PushPlugin] Handle specific error:", error.message);
  } else {
    console.error("[PushPlugin] Unexpected error:", error.message);
  }
}

// Handle specific error types when possible
if (error instanceof ValidationError) {
  // Handle validation errors
}
```

### Console Logging

- Use **module prefixes** in all console output: `[PushPlugin]`, `[Tunnel]`, `[Proxy]`
- Use **emojis** for status indicators: `✅`, `❌`, `💡`, `ℹ️`
- Log important steps and results

```typescript
console.log('[PushPlugin] Starting...');
console.error('[PushPlugin] Failed:', error.message);
console.log(`[Tunnel] URL: ${url}`);
console.log('✅ Server started successfully');
console.log('❌ Connection failed:', error.message);
```

### Async/Await

```typescript
// Use async/await over raw promises
async function startServer(): Promise<void> {
  try {
    await startProxy();
    await startTunnel();
  } catch (error) {
    // handle error
  }
}

// Never leave promises unhandled
// Use Promise.all() for parallel operations
const [result1, result2] = await Promise.all([
  operation1(),
  operation2(),
]);
```

## Test Patterns (Vitest)

### Test File Naming

- `*.test.ts` - Unit tests for modules
- Located alongside the module being tested (e.g., `localtunnel.ts` → `localtunnel.test.ts`)

### Test Structure

```typescript
import { describe, it, expect, beforeEach, afterEach } from "vitest";

describe("module name", () => {
  beforeEach(async () => {
    // Setup before each test
    const { clearState } = await import("./module");
    clearState();
  });

  afterEach(async () => {
    // Cleanup after each test
    const { cleanup } = await import("./module");
    await cleanup().catch(() => {});
  });

  describe("functionality group", () => {
    it("should do something", async () => {
      const { functionName } = await import("./module");
      const result = await functionName();
      expect(result).toHaveProperty("expected");
    });

    it("should throw on invalid input", async () => {
      const { functionName } = await import("./module");
      await expect(functionName(invalidInput)).rejects.toThrow("error message");
    });
  });
});
```

### Test Helpers for Tunnel Modules

Tunnel providers expose test helpers for isolation:

```typescript
// State management helpers
clearInstance();    // Reset module state
setInstance(mock);  // Set mock instance
getInstance();      // Get current instance

// Factory functions with DI
createLocaltunnel(config, { localtunnelModule: mockModule });
createCloudflareTunnel(config, mockSpawn, mockExistsSync, onUrl);
```

## Plugin Interface

All plugins must export a function matching the `Plugin` type from `@opencode-ai/plugin`:

```typescript
import type { Plugin } from "@opencode-ai/plugin";

export const PushNotificationPlugin: Plugin = async (ctx) => {
  // Initialize plugin
  return {
    event: async ({ event }) => {
      // Handle event
    },
  };
};

export default PushNotificationPlugin;
```

## Signal Handling

```typescript
// Handle process signals for graceful shutdown
const signals = ["SIGINT", "SIGTERM", "SIGHUP"];
signals.forEach((signal) => {
  process.on(signal, async () => {
    await gracefulShutdown();
    process.exit(0);
  });
});
```

## Key Patterns

1. **Single Entry Point**: `index.ts` is the only entry point (tsconfig includes only this file)
2. **Plugin Pattern**: Export a `Plugin` function returning an event handler
3. **Factory Functions**: Tunnel providers use `create*` functions for testability with dependency injection
4. **State Helpers**: Export `getInstance()`, `setInstance()`, `clearInstance()` for testing
5. **Graceful Shutdown**: Listen for SIGINT/SIGTERM/SIGHUP
6. **Bun Server**: Use `Bun.serve()` for HTTP servers
7. **Tunnel Providers**: Support ngrok, cloudflare, localtunnel with fallback
8. **Ngrok Multi-Strategy**: 4 fallback strategies if one fails
9. **Serve Mode Gate**: Only start the LAN server + auto-tunnel when `process.argv` includes `serve`; do NOT infer serve mode from `ctx.serverUrl` (it can be present for `opencode debug wait`)
10. **Tunnel Targets the Plugin**: The tunnel points at `pluginPort`, and the plugin
    reverse-proxies to OpenCode. This is what lets it serve and inject the mobile
    overlay. The plugin still binds `127.0.0.1` only -- the tunnel client is a local
    process dialling loopback.
11. **Only HTML is Buffered**: `src/proxy/forward.ts` streams every response except
    `text/html`. Buffering the SSE stream at `/event` would stall the UI, so any
    change there must keep the streaming path intact (see the SSE test in
    `forward.test.ts`).
12. **Forward the CSP Verbatim**: OpenCode's `content-security-policy` embeds a hash
    of its own theme-preload script. Never recompute or drop it. The overlay is
    designed to fit the existing policy (`style-src 'unsafe-inline'` for the
    stylesheet, `script-src 'self'` for the same-origin script).
13. **Segment-Aware Route Prefixes**: Use `matchesPrefix` in `src/proxy/route.ts`, not
    `startsWith`. Now that the plugin fronts the whole OpenCode API, a raw
    `startsWith("/tunnel")` would swallow real routes like `/tunnelling`.
14. **Overlay Selectors are Best-Effort**: The overlay targets OpenCode's
    `data-component` / `data-slot` attributes. If upstream renames one, the rule
    stops applying -- acceptable. Never make the page's function depend on a rule
    landing. Two traps worth naming: upstream ships two generations of most
    controls, so a rule that lists only the v1 selector silently does nothing on
    the phone (the v2 set renders there); and it ships two layouts, so anything
    keyed to the app shell has to say which one it means.
15. **Never Add Padding an Upstream Layout Already Adds**: `layout-new.tsx`
    applies `padding-top`/`padding-bottom` from the safe-area insets to its own
    root; `layout.tsx` applies neither. A rule on `#root` that is not gated on
    the layout doubles the inset on one of them.
16. **Size Floors Need Room to Grow**: A `min-width`/`min-height` floor only
    helps where the container can accommodate it. In a fixed-height row inside
    an `overflow-clip` ancestor -- the composer's control row -- a floor makes
    the control overflow its slot and paint over its neighbour. Grow the tap
    area with an inset pseudo-element there instead.
17. **The Plugin's Own Routes Are Outside OpenCode's Auth**: `/push-token`,
    `/tunnel` and `/__oc-mobile/*` are answered before OpenCode is consulted, so
    `OPENCODE_SERVER_PASSWORD` does not cover them. Any new locally-answered
    route must go through `guardPluginRoute`. Never give one a wildcard CORS
    origin: the consumer is a native app that does not enforce CORS, and the
    wildcard lets any page the user visits drive it against loopback.
18. **A Caller Never Chooses A Port, Path Or Host To Open**: `POST /tunnel`
    accepted `body.port` and published it. Constrain to values this process
    already owns, and enforce it independently of authentication.
19. **Auth Checks Are Made Anonymously Or They Prove Nothing**: `scripts/doctor.mjs`
    probes the public URL *without* credentials in its edge-authentication
    section. Sending the password would answer "can I get in", when the question
    is "what does someone holding only the URL get". Earlier doctor sections
    made the opposite mistake and read a 401 as a failure.
20. **Per-Session State, Not Globals**: Anything derived from the event stream
    is keyed by session id. A single global "what is running" let a tool
    starting in any session relabel the status bar for the one on screen, and
    let a sub-agent finishing clear its parent's label.
21. **Child Sessions Are Attributed, Never Named Alone**: A sub-agent's session
    id means nothing to the user. Surface its work against the parent they
    started, labelled as delegated. Children still get no chip of their own and
    no notification of their own -- `formatNotification` suppresses them
    globally, and any new notification kind inherits that.
22. **A Progress Notification Is Not A Start Notification**: Arm on busy, cancel
    on settle, fire once. A push for every turn that begins is noise, because
    most turns end before you could read it.
23. **Safe-Area Insets Describe The Device, Not What Covers It**: iOS keeps
    reporting `env(safe-area-inset-bottom)` at full value with the keyboard up,
    so any layout that pads for the home indicator reserves dead space above the
    keyboard. Collapse it while `#root[data-oc-keyboard="open"]` is set.
24. **Measure, Do Not Read Gaps Off Screenshots**: two layout rounds were
    diagnosed by converting screenshot pixels to points, which is slow and
    ambiguous when two causes predict a similar gap. The debug readout
    (`OPENCODE_MOBILE_OVERLAY_DEBUG=1`) exists so the phone reports the numbers;
    extend it rather than re-deriving them.
25. **Colour And Depth Come From Upstream's Tokens**: use `var(--v2-*)` with a
    neutral fallback, never a hard-coded hex, for anything that sits on the
    app's own surfaces. The overlay cannot detect the active theme from a
    stylesheet, so a literal colour is wrong in one of them. The strip's state
    colours are the deliberate exception -- they carry meaning, and they are
    paired with a `prefers-color-scheme` block.
26. **Check Whether Upstream Already Draws It**: `[data-slot="user-message-text"]`
    already had the bubble -- background, padding, radius -- and the container
    already right-aligned it. Adding a box produced a bubble inside a bubble.
    Read the component's own CSS before styling a container around it; the
    overlay's job is usually to adjust what exists, not to add a layer.
27. **Mirror The App's API Addressing, Never Derive It**: a call to OpenCode
    must name its instance (`?directory=` or `x-opencode-directory`), and on top
    of that sits a workspace/server proxy layer where `GET /session` is local
    while `/session/status` forwards. The v2 route encodes a server key, not a
    directory, so the client cannot reconstruct it. A request naming none
    succeeds and returns nothing -- 200 with an empty array, a stream of
    heartbeats -- so the failure looks like an empty account, not a misrouted
    call. The overlay taps `window.fetch` to learn the addressing the app is
    already using and reuses it verbatim, event-stream URL included. Do not
    reintroduce a guess; the proxy's default is only a backstop. Learn ONLY the
    addressing parameters (`directory`, `workspace`) -- taking a whole query
    string picks up the caller's pagination, and appending
    `?limit=200&before=<cursor>` to `/session` asks the wrong question and looks
    like an empty account. A call that addresses nothing must never unlearn one
    that did.
28. **OpenCode Ships Two Event Schemas**: `packages/schema/src/` is current,
    `packages/schema/src/v1/` is the old one, and names differ in both the event
    and its fields -- `permission.v2.asked {action, resources}` versus
    `permission.asked {permission, patterns}`. Check the schema before
    filtering on an event name; `permission.updated` was filtered on for months
    and exists in neither. Handle both generations rather than picking one.
29. **Live Events Are Not A Substitute For Fetching State**: an event only
    reaches a client that was connected when it fired. The overlay set
    `attention` solely from `question.asked` / `permission.asked`, so anything
    asked before the page loaded was invisible -- which is the entire
    monitoring case. Fetch the pending list on load as well, and rebuild it
    wholesale so a request answered elsewhere stops showing.
30. **Blocking Events Are Never Suppressed**: there are two -- a permission
    request and a question -- and both stop the session until a human answers.
    The child-session filter exists because sub-agent completions are noise;
    these are the opposite, so suppressing one stalls the work silently. Any new
    "quiet by default" filter has to exempt both, and anything that reports
    "still working" has to treat them as not working.
31. **A MutationObserver On `document.body` Must Not See Its Own Writes**: the
    overlay watches body for `childList` to re-mount after SPA navigation, and
    every renderer it calls writes to the DOM -- which is a childList mutation
    in body. Left connected, the callback re-enters on its own output forever,
    pegs the main thread, and every control on the page stops responding,
    OpenCode's included. Disconnect, do the work, `takeRecords()` to discard
    what the writes queued, reconnect. Renderers should also be idempotent, so
    they queue nothing when nothing changed.
32. **A Viewport-Sized Element Must Not Carry `pointer-events: auto`**: check
    what is always in the DOM before enlarging anything. `dialog-v2` and its
    container are plain divs that always render -- only the Kobalte content
    mounts and unmounts -- so sizing the container to the viewport turns it into
    an invisible full-screen click shield. Move the click target to the part
    that actually comes and goes.
33. **`opencode serve` Loads No Plugins Until A Request Arrives**: it is declared
    `instance: false` and resolves an instance per request, so nothing this
    plugin does -- the proxy, the tunnel, the banner -- happens at startup. Use
    `npm run serve`, which pokes the server once. Anything that assumes the
    plugin is up right after `opencode serve` returns is wrong.
34. **Drive Upstream's Controls, Do Not Reimplement Them**: the Session /
    Changes switch is local component state in `session.tsx`, so the overlay
    clicks the real `[data-slot="tabs-trigger"][data-value="..."]` rather than
    trying to own the state. Hide such a control with `display: none` on its
    container, never remove it -- the triggers must stay in the DOM to be
    clickable.
35. **Backslashes In `mobile-js.ts` Must Be Doubled**: the script lives in a
    template literal. A *valid* escape (`\u`, `\n`) resolves at build time and
    is harmless; an *invalid* one (`\d`, `\s`, `\w`) silently loses its
    backslash. `/\d+/` shipped as `/d+/` and matched the "d" in "changed".
    Tests assert on the built asset, which is the only place this is visible.
36. **The Keyboard Is Script-Only**: iOS does not shrink the layout viewport for
    the software keyboard, and `#root` is `height: 100vh` in standalone mode by
    upstream's deliberate choice. Only `visualViewport` sees the keyboard; no
    CSS unit does. Anything that pins the shell must apply solely while
    installed and at phone widths, and must hand the height back when the
    keyboard closes.
37. **A Pending Question Exists Only In The Process That Asked It**: `Question.Service`
    holds requests in an in-memory `Map` inside `InstanceState`, blocked on a
    `Deferred` (`packages/opencode/src/question/index.ts`); permissions are the
    same. Nothing is written to storage. Sessions and messages *are* -- files
    under OpenCode's data directory -- so a second server process reading the
    same directory shows the session and its transcript while being unable to
    see the question. Before treating an empty `GET /question` as a bug, check
    whether the agent is running under the same server the phone is proxied to.
38. **Answering Is Two Endpoints, And They Are The Only Writes**: `POST
    /question/<id>/reply` takes `{answers: string[][]}` -- one array of chosen
    labels per question, in order -- `/reject` takes no body, and `POST
    /permission/<id>/reply` takes `{reply: "once" | "always" | "reject"}`. The
    overlay is otherwise read-only, and `serve.test.ts` asserts on the built
    asset that these four routes are the entire write surface. Widening it is a
    deliberate act, not a side effect.
39. **Render Nothing Where Upstream Already Renders Something**: the ask dock
    checks for `[data-component="session-question-dock"]` and
    `session-permission-dock` and stands down when either is present. Same rule
    as #26 (the double bubble) but for a whole feature rather than a style: the
    overlay's job is to fill a gap, and two docks for one request is worse than
    none.
40. **The Event Hook Is In-Process; Serving Is Not A Prerequisite For It**: a
    plugin's `event` handler is called on the bus of whichever OpenCode process
    loaded it, and sending a push needs only the token file and an outbound call
    to Expo -- no plugin server, no tunnel (the deep link comes from the tunnel
    metadata on disk). The plugin used to return a no-op handler in any process
    without `serve` in argv, and again in a serving process that lost the plugin
    port, which silenced every agent running outside the serving process. Gate
    the *server and tunnel* on serving; gate notifying on
    `OPENCODE_MOBILE_NOTIFY_ALWAYS` instead (see `src/push/role.ts`). Off by
    default: notifying from a TUI you are sitting at is noise.
41. **A Blocking Tool's Own Part Is A Signal Worth Reading**: the `question`
    tool blocks inside its `execute` while `question.ask` waits, so its
    `message.part.updated` part stays `running` for exactly as long as the
    question is pending -- and those updates repeat. That makes it a third,
    network-free source for "blocked on a human", alongside the live event
    (which only reaches a client connected when it fired) and the fetch (a
    20-second poll). Mark from it and retire on completion, symmetrically;
    debounce anything that refetches, because the part updates constantly. The
    fetch stays authoritative -- the part marks, it does not decide.
42. **`mobile-js.ts` Has No Backticks Or `${` Either**: same cause as #35 -- the
    script is a template literal, so a backtick in a *comment* opens a nested
    literal and the file stops parsing. `tsc` catches it as a stray
    "';' expected", which does not read like the real problem. Use single quotes
    in the injected script's prose.

## Configuration

### TypeScript (tsconfig.json)

```json
{
  "compilerOptions": {
    "target": "ES2020",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true
  },
  "include": ["index.ts"],
  "exclude": ["node_modules", "dist"]
}
```

### Vitest (vitest.config.ts)

```typescript
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    include: ["**/*.test.ts"],
    exclude: ["node_modules", "dist"],
    coverage: {
      provider: "v8",
      reporter: ["text", "json", "html"],
    },
  },
});
```

## Coverage

`vitest.config.ts` enforces an 85% threshold on statements, branches, functions
and lines, measured with `all: true` over `src/overlay`, `src/proxy`, `src/push`
and `src/tunnel`. Because `all` is on, adding an untested module lowers the score
rather than being invisible -- new code needs tests to land.

Excluded from the measurement, deliberately:

| Excluded | Why |
|---|---|
| `**/types.ts` | Type-only; compiles to nothing and reports as 0/0 |
| `**/index.ts` | Barrels; re-exports with no logic |
| `index.ts` (root) | Plugin entry with module-load side effects. Its routing was extracted to `src/proxy/route.ts` so it could be tested. |
| `src/cli/**` | One-shot interactive installers, no runtime role in a session |

**Testing network-dependent code.** Nothing in the default suite may touch the
network or require an external binary. The providers all expose dependency
injection for this -- use it rather than skipping:

- `createLocaltunnel(config, { localtunnelModule })`
- `createCloudflareTunnel(config, spawnFn, existsSyncFn, onUrl, loadConfig)`
- ngrok has no factory; mock `@ngrok/ngrok` and `child_process` instead
- Modules that resolve paths from `process.env.HOME` at import time (token-store,
  metadata, filters, cloudflare config, ngrok config) need HOME redirected to a
  temp dir plus `vi.resetModules()` before a dynamic import

Live suites are gated behind an env var (`OPENCODE_TEST_NGROK_LIVE=1`) and are
skipped by default.

## Runtime

- **Runtime**: Bun (not Node.js)
- **TypeScript**: Strict mode enabled
- **No ESLint/Prettier**: Follow existing patterns manually
- **Testing**: Vitest with globals plugin

## Dependencies

| Dependency | Purpose |
|------------|---------|
| `@opencode-ai/plugin` | Core plugin interface |
| `@ngrok/ngrok` | Ngrok SDK |
| `localtunnel` | Localtunnel provider |
| `qrcode` | QR code generation |
| `cloudflared` | Cloudflare tunnel binary |

## Important Notes

- **tsconfig.json** includes only `index.ts` - TypeScript follows imports automatically
- Old test files (`test-tunnel.ts`, `test-utils.ts`, `test-tunnel.ts`) should be deleted if found
- Test files use `.test.ts` suffix and live alongside the module they test
- Use `npx vitest run` for CI, `npx vitest ui` for development
