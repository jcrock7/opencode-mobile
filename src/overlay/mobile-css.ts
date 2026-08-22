/**
 * The injected stylesheet.
 *
 * Everything is `!important` on purpose. OpenCode's own rules are CSS-nested
 * (e.g. `[data-component="tool-trigger"] [data-slot="basic-tool-tool-subtitle"]`
 * is specificity 0,2,0) and its stylesheet is injected at runtime by the app
 * bundle, so neither a flat selector nor document order reliably wins. An
 * overlay is the one place `!important` is the correct tool.
 *
 * Selectors target the `data-component` / `data-slot` attributes the session UI
 * styles itself through. If upstream renames one, that rule stops applying --
 * it does not break the page.
 */

import type { OverlayConfig } from "./types";

export function buildOverlayCss(config: OverlayConfig): string {
  return `/* opencode-mobile overlay -- injected by the plugin proxy */
@media (max-width: ${config.maxWidth}px) {

  /* 1. Stop hiding what the agent is doing.
        These slots are nowrap + ellipsis upstream, which on a phone cuts file
        names and command lines mid-word. */
  [data-slot="message-part-title-filename"],
  [data-slot="message-part-directory"],
  [data-slot="message-part-filename"],
  [data-slot="basic-tool-tool-subtitle"],
  [data-slot="apply-patch-filename"],
  [data-slot="apply-patch-directory"] {
    white-space: normal !important;
    overflow: visible !important;
    text-overflow: clip !important;
    word-break: break-word !important;
    /* the directory slot is direction: rtl upstream so the path tail survives
       the ellipsis; wrapping makes that unnecessary and rtl reorders text. */
    direction: ltr !important;
    text-align: start !important;
  }

  /* Let the wrapped title block use the full row instead of one flex line. */
  [data-slot="message-part-path"] {
    flex-wrap: wrap !important;
    min-width: 0 !important;
  }

  /* 2. Readable prose. Upstream is 14px at every viewport. */
  [data-component="markdown"] {
    font-size: 16px !important;
    line-height: 1.55 !important;
  }
  [data-component="markdown"] p,
  [data-component="markdown"] li {
    overflow-wrap: break-word !important;
  }

  /* 3. Code and diffs scroll in their own box instead of squeezing or
        wrapping. A wrapped diff loses its +/- gutter alignment. */
  [data-component="markdown-code"],
  [data-component="code"],
  [data-component="diff"],
  [data-component="bash-output"],
  [data-component="tool-output"] {
    font-size: 13px !important;
    max-width: 100% !important;
    overflow-x: auto !important;
    -webkit-overflow-scrolling: touch;
  }
  [data-component="markdown-code"] pre,
  [data-component="bash-output"] pre,
  [data-component="tool-output"] pre {
    white-space: pre !important;
    word-break: normal !important;
  }

  /* 4. Give the timeline its scrollbar back. Upstream hides it; on a long
        session that removes the only cue for where you are. */
  [data-slot="session-turn-content"] {
    scrollbar-width: thin !important;
    overscroll-behavior-y: contain !important;
  }
  [data-slot="session-turn-content"]::-webkit-scrollbar {
    display: block !important;
    width: 3px !important;
  }
  [data-slot="session-turn-content"]::-webkit-scrollbar-thumb {
    background: currentColor !important;
    opacity: 0.25 !important;
    border-radius: 3px !important;
  }

  /* 5. Touch targets. 44pt is the floor Apple documents. */
  [data-component="tool-trigger"],
  [data-component="edit-trigger"],
  [data-component="write-trigger"],
  [data-component="collapsible"] > button,
  [data-component="accordion"] > button {
    min-height: 44px !important;
  }

  /* 6. Reclaim the fixed 64px rail. Below 1280px OpenCode already provides an
        off-canvas drawer, so the rail is duplicated navigation costing ~16% of
        an iPhone's width. */
  [data-component="sidebar-rail"] {
    display: none !important;
  }

  /* 7. Respect the home indicator so the composer is not half off-screen. */
  [data-component="dock-prompt"] {
    padding-bottom: max(env(safe-area-inset-bottom), 8px) !important;
  }
}

/* ---- session switcher strip ----------------------------------------------
   Rendered by overlay.js. Styles live here (unconditionally, so the strip is
   never unstyled) but the element only ever mounts on narrow viewports. */

[data-oc-strip] {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 8px;
  overflow-x: auto;
  overflow-y: hidden;
  -webkit-overflow-scrolling: touch;
  scrollbar-width: none;
  border-bottom: 1px solid var(--border-weaker-base, rgba(127, 127, 127, 0.18));
  background: var(--v2-background-bg-deep, var(--background-base, transparent));
  font-family: var(--font-family-sans, system-ui, sans-serif);
}

[data-oc-strip]::-webkit-scrollbar {
  display: none;
}

[data-oc-strip][hidden] {
  display: none;
}

[data-oc-chip] {
  flex: none;
  display: inline-flex;
  align-items: center;
  gap: 5px;
  max-width: 48vw;
  min-height: 32px;
  padding: 4px 9px;
  border-radius: 6px;
  border: 1px solid transparent;
  font-size: 12px;
  font-weight: 500;
  line-height: 1.2;
  text-decoration: none;
  color: var(--text-weak, #6b7280);
  background: var(--background-element, rgba(127, 127, 127, 0.1));
  white-space: nowrap;
}

[data-oc-chip] > [data-oc-chip-label] {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

[data-oc-chip] > [data-oc-chip-dot] {
  flex: none;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: currentColor;
}

/* The four states, matching the plugin's own notification vocabulary. */
[data-oc-chip][data-oc-state="busy"]      { color: #0c6e68; background: rgba(12, 110, 104, 0.12); }
[data-oc-chip][data-oc-state="attention"] { color: #a0522a; background: rgba(160, 82, 42, 0.14); }
[data-oc-chip][data-oc-state="error"]     { color: #a6342a; background: rgba(166, 52, 42, 0.14); }
[data-oc-chip][data-oc-state="idle"]      { color: var(--text-weak, #6b7280); }

[data-oc-chip][data-oc-current="true"] {
  border-color: currentColor;
  font-weight: 600;
}

[data-oc-chip][data-oc-state="busy"] > [data-oc-chip-dot] {
  animation: oc-strip-pulse 1.4s ease-in-out infinite;
}

@keyframes oc-strip-pulse {
  0%, 100% { opacity: 1; }
  50%      { opacity: 0.3; }
}

@media (prefers-reduced-motion: reduce) {
  [data-oc-chip][data-oc-state="busy"] > [data-oc-chip-dot] { animation: none; }
}

@media (prefers-color-scheme: dark) {
  [data-oc-chip][data-oc-state="busy"]      { color: #4ec3b8; background: rgba(78, 195, 184, 0.14); }
  [data-oc-chip][data-oc-state="attention"] { color: #e0925d; background: rgba(224, 146, 93, 0.16); }
  [data-oc-chip][data-oc-state="error"]     { color: #e4695d; background: rgba(228, 105, 93, 0.16); }
}
`;
}
