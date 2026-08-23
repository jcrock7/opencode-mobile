# Implementation Plan: Mobile Web Overlay

Status key: `[x]` built and verified, `[ ]` outstanding.

## Problem

Browsing the tunnel URL on a phone serves OpenCode's own web UI (`sst/opencode`,
`packages/app` + `packages/session-ui`, embedded in the binary and served at `/`).
It is desktop-designed. Measured against `sst/opencode@3a31c4e`:

| Observation | Measured |
|---|---|
| Viewport media queries in the session-rendering CSS (~2,600 lines) | 0 |
| Components with any responsive breakpoint class | 23 / 146 |
| Truncation rules in the timeline | 14 `nowrap`, 12 `ellipsis` |
| Distinct "is mobile" breakpoints in use | 2 (768px, 1280px) |
| Type scale, fixed at all widths | 13 / 14 / 11px |
| Tool parts expanded by default | none (`shellToolPartsExpanded`, `editToolPartsExpanded` both `false`) |

Consequences on a 390pt screen: file names and command lines cut mid-word, prose too
small, code squeezed rather than scrolled, no scroll position cue, and session
switching is a four-action drawer trip with no awareness of the other sessions.

## Constraint that shapes the design

The UI is upstream code we do not own. But it arrives over a tunnel this plugin
opens, so the plugin can sit in front of it. OpenCode serves the UI under a strict
CSP; the overlay must fit inside that policy rather than fight it:

- `style-src 'self' 'unsafe-inline'` → an injected `<link>` is permitted
- `script-src 'self'` (no `unsafe-inline`) → an injected `<script src>` is permitted
  only if served same-origin, which the proxy is

## Architecture

```
Phone → tunnel → plugin (127.0.0.1) → OpenCode (:4096)
                   ├── /push-token      local
                   ├── /tunnel          local
                   ├── /__oc-mobile/*   overlay assets
                   └── /*               forwarded; text/html rewritten
```

The plugin stays bound to loopback: the tunnel client is a local process dialling
`127.0.0.1`, so nothing needs LAN exposure.

## Deliverables

### D1 — Overlay configuration `[x]`
- `src/overlay/config.ts`, `src/overlay/types.ts`
- Env-driven, opt-out: `OPENCODE_MOBILE_OVERLAY`, `OPENCODE_MOBILE_OVERLAY_STRIP`,
  `OPENCODE_MOBILE_OVERLAY_MAX_WIDTH`
- Asset routes namespaced under `/__oc-mobile/` so they cannot shadow an app route
- Reject out-of-range breakpoints rather than honouring a typo

### D2 — Overlay stylesheet `[x]`
- `src/overlay/mobile-css.ts`
- Un-truncate the 5 slots that ellipsise paths and tool subtitles
- Prose → 16px; code/diffs/tool output scroll in their own box, never wrap
- Restore the timeline scrollbar; 44px touch targets; hide the redundant 64px rail;
  pad the composer for the home indicator
- `!important` throughout: upstream rules are CSS-nested (0,2,0) and injected at
  runtime, so neither specificity nor document order reliably wins
- Session-strip styling lives outside the media query so the strip is never unstyled

### D3 — Session switcher script `[x]`
- `src/overlay/mobile-js.ts`
- Reads `GET /session`, `GET /session/status`, `GET /event` (SSE). Writes nothing.
- Four states — working / needs you / failed / idle — matching the vocabulary the
  plugin's notifications already use; "needs you" sorts first
- Defensive about field names across OpenCode versions; child sessions excluded
- Reconnects with exponential backoff; re-mounts after SPA navigation; hides itself
  below two sessions; never throws into the host page
- Navigates by swapping the session id in the current path (version-agnostic) via a
  real `<a href>` so the SPA router intercepts

### D4 — HTML injection `[x]`
- `src/overlay/inject.ts`
- Pure, idempotent (marker attribute), preserves the closing tag's indentation
- Fallback chain: `</head>` → after `<body>` → `</html>` → append

### D5 — Asset serving `[x]`
- `src/overlay/serve.ts`
- Correct content types, weak ETag, 304 on `If-None-Match`, HEAD, 405 on writes
- Memoised per config

### D6 — Streaming reverse proxy `[x]`
- `src/proxy/forward.ts`
- Only `text/html` is buffered; SSE/API/downloads stream untouched
- WebSocket upgrades proxied, both sockets' lifetimes tied together
- CSP forwarded verbatim; `Authorization` forwarded; `content-length` recomputed
- Compressed HTML passed through rather than corrupted; `accept-encoding` stripped
  only for navigations; 8 MiB buffer ceiling with graceful fallthrough
- 502 when OpenCode is not listening; upstream torn down on client disconnect

### D7 — Request routing `[x]`
- `src/proxy/route.ts`
- Pure function so the contract is testable
- Segment-aware prefix matching (a bare `startsWith` would swallow `/tunnelling`)
- CORS preflight answered locally only for the plugin's own endpoints

### D8 — Wiring `[x]`
- `index.ts`: tunnel targets `pluginPort`; routing switch; upgrade handler; the
  manual `/tunnel` endpoint defaults to the plugin port too
- Loopback bind retained; startup log states the active routes

### D9 — Notification defects `[x]`
- A1 expanded bodies keep line structure (`truncateMultiline`)
- A2 titles name the project instead of a constant
- A3 iOS `threadId`/`summaryArg` on all four branches
- A6 `session.error` gets the same body budget and expanded style as completions

### D10 — Documentation `[x]`
- README: overlay section, security section, env vars, troubleshooting, structure
- AGENTS.md: module layout plus the invariants a future change must not break

### D11 — Test suite `[x]`
- 100% pass across the whole suite
- ≥85% statement coverage on the code this work owns
- Pre-existing tunnel-provider tests that hit the real network must be converted to
  the dependency injection the module already exposes, not deleted or weakened

### D12 — Verification pass `[x]`
- Re-read each deliverable against the built code and record the result
  (see Verification below)

## Non-goals

- Forking or vendoring OpenCode's UI
- Reimplementing markdown/diff rendering that already works
- Adding authentication (OpenCode already has `OPENCODE_SERVER_PASSWORD`; the
  proxy forwards it and the README documents it)


## Verification

Every deliverable re-checked against the built code.

| # | Deliverable | Verified by |
|---|---|---|
| D1 | Overlay config | 3 env vars honoured; routes namespaced under `/__oc-mobile/`; out-of-range breakpoints rejected. 26 tests. |
| D2 | Overlay stylesheet | All 5 truncated slots targeted; 16px prose; 44px targets across both the v1 and v2 control sets, with the titlebar released to fit them; scrollbar restored; safe-area padding. The planned "hide the redundant rail" step was dropped: the desktop rail is already `hidden xl:block` upstream, so the only rail on a phone is the drawer's project navigation, and hiding it emptied the drawer. |
| D3 | Session strip | Reads `/session`, `/session/status`, `/event`; backoff; re-mounts after SPA nav; hides below 2 sessions; no write verbs present. |
| D4 | HTML injection | Idempotent; indentation preserved; 3-step fallback chain. 21 tests. |
| D5 | Asset serving | Content types, ETag/304, HEAD, 405, memoisation. 21 tests. |
| D6 | Streaming proxy | HTML-only rewrite; SSE proven to stream incrementally against a real server; upgrades proxied end to end; only `content-length`/`transfer-encoding` are ever deleted, so the CSP is forwarded verbatim; compressed HTML passed through; 8 MiB ceiling with replay. 40 tests. |
| D7 | Routing | Segment-aware prefixes; preflight scoped to plugin routes. 36 tests. |
| D8 | Wiring | Tunnel targets `pluginPort`; loopback bind retained; upgrade handler registered; manual `/tunnel` defaults to the plugin port. 11 assembled-server tests. |
| D9 | Notification fixes | A1 `truncateMultiline` keeps newlines; A2 project in title; A3 `iosThread` on all 4 branches; A6 error gets 320 chars + `bigtext`. 55 tests. |
| D13 | Sub-agent visibility | Child sessions keep their parentage; a sub-agent's running tool reports on its parent's status bar, labelled as one; the parent chip badges its busy-child count. Also fixed the single-global `running` that let any session relabel the bar. 9 DOM tests. |
| D14 | Progress notifications (A4) | `src/push/progress.ts`: a timer armed on busy and cancelled on settle, so only work outliving the delay notifies. One per busy period, names the running tool, attributes sub-agents to the parent, silent at normal priority, `unref`'d. 46 tracker tests + 10 formatter tests + 2 sender tests. |
| D10 | Documentation | README overlay/security/env/troubleshooting sections; AGENTS.md module layout and 5 new invariants. |
| D11 | Tests | 586 passing, 0 failing, 2 skipped (live-ngrok, opt-in). Coverage 90.08% statements / 87.53% branches / 94.47% functions / 90.19% lines, all above the enforced 85% threshold. |

### Coverage scope

`vitest.config.ts` measures `src/overlay`, `src/proxy`, `src/push` and `src/tunnel`
with `all: true`, so an untested module cannot raise the score by being absent.
Excluded, with reasons:

- `**/types.ts` — type-only, compiles to nothing, reports as 0/0
- `**/index.ts` — barrels, re-exports with no logic
- `index.ts` (plugin entry) — module-load side effects make it untestable in
  place; its routing logic was extracted to `src/proxy/route.ts` (100%) precisely
  so it could be tested
- `src/cli/**` — one-shot interactive installers with no runtime role in a session

### Defects found and fixed while testing

Writing the tests surfaced five real bugs, all fixed:

1. `src/tunnel/cloudflare.ts` — the free-tier branch called the real `spawn`
   instead of the injected one, making the `spawnFn` parameter a no-op on the
   default path. Two existing tests had been failing because of it.
2. `src/tunnel/ngrok.ts` — `ensureNgrokReady` prompted on stdin unconditionally,
   so it hung forever in any non-interactive context (CI, a pipe, a test). Now
   defaults to whether stdin is a TTY.
3. `src/tunnel/ngrok.ts` — strategy 3's inline `require("child_process")` shadowed
   the module's own top-level `spawn` import, leaving it dead and the call opaque
   to mocking.
4. `src/proxy/route.ts` — `startsWith("/tunnel")` also matched `/tunnelling`, and
   `startsWith("/push-token")` matched `/push-tokens-report`. Harmless while
   unmatched paths 404'd; a silent API breakage once the plugin fronts OpenCode.
5. `src/proxy/forward.ts` — an upgrade socket's peer was not torn down on close,
   leaking the upstream socket when a phone dropped off the tunnel.

Also removed, as dead code nothing imported: `assistant-message.ts`,
`log-level-test.ts`, `sdk-logger.ts`, `src/push/notification-handler.ts`, and
`findCloudflareD` in `src/tunnel/cloudflare.ts`.

### Not verified here

No part of this has run on a real phone against a real OpenCode server. The
proxy, injection and asset serving are covered against a stand-in OpenCode, and
the overlay's selectors were read off `sst/opencode@3a31c4e` -- but selector drift
and real-device layout need a real load. The README's troubleshooting section has
the `curl` checks for confirming the assets and the injected `<link>` arrive
through the tunnel.
