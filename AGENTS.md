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
    landing.

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
