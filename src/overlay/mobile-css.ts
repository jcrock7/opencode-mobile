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
  /**
   * Three tiers for the transcript.
   *
   * Upstream renders your prompt, the agent's prose and every tool row at the
   * same weight, in the same colour, down the same full-width column. On a
   * phone that reads as one undifferentiated wall of text -- you cannot tell
   * where your message ended and the answer began, and a shell command looks
   * exactly like a sentence.
   *
   * The hooks are `data-timeline-row`, which upstream sets to the row's own tag
   * (UserMessage / AssistantPart / Thinking / Error / Retry / DiffSummary /
   * TurnGap / TurnDivider / CommentStrip), and `data-component="tool-trigger"`
   * for a tool row.
   *
   * A note on the rail: it is a `border-left` on each assistant row rather than
   * one border on a container, because there is no element wrapping a whole
   * response. That works because the row frame carries its own `pt-3` between
   * consecutive assistant parts, so the borders butt together into a
   * continuous line -- and normal turns are separated by a `TurnGap` row, which
   * has no border, so the rail breaks exactly at the turn boundary.
   */
  const bubbles = config.bubbles
    ? `
/* ---- transcript tiers (OPENCODE_MOBILE_OVERLAY_BUBBLES=0 to disable) -------- */
@media (max-width: ${config.maxWidth}px) {
  /* 1. Your message: a bubble, inset from the right so it reads as yours.
        The squared bottom-right corner is the tail -- an asymmetric radius
        rather than a pseudo-element triangle, which would have to know the
        bubble's background and would break on a theme change. */
  [data-timeline-row="UserMessage"] [data-slot="session-turn-message-content"] {
    margin-left: auto !important;
    max-width: 88% !important;
    padding: 10px 12px !important;
    border-radius: 14px 14px 4px 14px !important;
    background: var(--v2-background-bg-layer-02, rgba(127, 127, 127, 0.14)) !important;
    box-shadow: inset 0 0 0 0.5px var(--v2-border-border-muted, rgba(127, 127, 127, 0.28)) !important;
  }

  /* 2. The response: full width -- prose, code and diffs all need the room --
        but railed, so the whole answer reads as one channel. */
  [data-timeline-row="AssistantPart"],
  [data-timeline-row="Thinking"],
  [data-timeline-row="DiffSummary"],
  [data-timeline-row="Error"],
  [data-timeline-row="Retry"] {
    border-left: 2px solid var(--v2-border-border-muted, rgba(127, 127, 127, 0.28)) !important;
  }
  /* The rail eats 2px; give it back rather than letting the text shift. */
  [data-timeline-row="AssistantPart"] [data-slot="session-turn-message-container"],
  [data-timeline-row="Thinking"] [data-slot="session-turn-message-container"] {
    padding-left: 10px !important;
  }
  /* A problem is worth colouring; nothing else is. */
  [data-timeline-row="Error"],
  [data-timeline-row="Retry"] {
    border-left-color: #e4695d !important;
  }

  /* 3. Tool rows: machinery, not prose. Demoted to a subdued card so the eye
        can skip them when reading and find them when scanning. */
  [data-component="tool-trigger"] {
    border-radius: 8px !important;
    padding: 6px 8px !important;
    background: var(--v2-background-bg-layer-01, rgba(127, 127, 127, 0.07)) !important;
  }

  /* Thinking is the least of the three; make it look it. */
  [data-timeline-row="Thinking"] {
    opacity: 0.75 !important;
  }
}
`
    : "";

  const debugBadge = config.debug
    ? `
/* ---- debug badge (OPENCODE_MOBILE_OVERLAY_DEBUG=1) --------------------------
   Proof that this stylesheet is loaded and in scope. Pure CSS so it works even
   with the session strip disabled, and pointer-events: none so it can never
   swallow a tap. */
@media (max-width: ${config.maxWidth}px) {
  html::after {
    content: "oc-mobile overlay active (<= ${config.maxWidth}px)";
    position: fixed !important;
    left: 0 !important;
    bottom: env(safe-area-inset-bottom, 0px) !important;
    z-index: 2147483647 !important;
    padding: 2px 6px !important;
    background: #0c6e68 !important;
    color: #ffffff !important;
    font: 600 10px/1.4 ui-monospace, "SF Mono", Menlo, monospace !important;
    letter-spacing: .02em !important;
    pointer-events: none !important;
  }
}
`
    : "";

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

  /* NOTE: do not hide [data-component="sidebar-rail"].
     An earlier version of this overlay did, on the assumption that the rail was
     pinned on screen at every width. It is not: the persistent sidebar
     ([data-component="sidebar-nav-desktop"]) is already 'hidden xl:block', so
     OpenCode hides that rail below 1280px itself. The only rail rendered on a
     phone is the one INSIDE the drawer, which carries the project avatars and
     the "open project" button -- hiding it gained nothing and removed the
     drawer's project navigation. */

  /* 6. Respect the home indicator so the composer is not half off-screen.
        A flat 8px by default: the v2 layout (layout-new.tsx) already pads its
        own root by the bottom inset, so adding the inset here as well doubles
        it -- about 68px of dead space under the composer on a Dynamic Island
        phone. The legacy layout pads nothing, so there it gets the inset. */
  [data-component="dock-prompt"],
  [data-component="session-prompt-dock"],
  [data-component="session-followup-dock"] {
    padding-bottom: 8px !important;
  }
  #root:has([data-component="sidebar-nav-mobile"]) [data-component="dock-prompt"],
  #root:has([data-component="sidebar-nav-mobile"]) [data-component="session-prompt-dock"],
  #root:has([data-component="sidebar-nav-mobile"]) [data-component="session-followup-dock"] {
    padding-bottom: max(env(safe-area-inset-bottom), 8px) !important;
  }

  /* 7. Touch targets. 44pt is Apple's documented floor and every control here
        is well under it: IconButton is 20/24/28px square, button-v2 is
        24/28/32px tall, and the segmented control is 28px.

        Two things matter. min-WIDTH as much as min-height -- the icon buttons
        set explicit square dimensions, so raising only the height yields a tall
        thin button. And the v2 component set has to be listed separately: the
        earlier version of this rule named only the v1 selectors, which is why
        it changed almost nothing. */

  /* The titlebar has to be able to hold a 44pt control. There is exactly one
     <header> in the app -- the titlebar -- and in its non-v2 form it is a 40px
     box with overflow: hidden, which would clip a taller button outright. */
  header {
    height: auto !important;
    min-height: 48px !important;
    overflow: visible !important;
  }

  /* Icon-only controls: square, so they need both floors. */
  [data-component="icon-button"],
  [data-component="icon-button-v2"],
  [data-component="desktop-icon-button"],
  [data-component="split-button-v2-menu-trigger"],
  [data-component="session-tab-popover-trigger"],
  [data-component="accordion-v2-trigger"],
  [data-component="context-tool-group-trigger"] {
    min-width: 44px !important;
    min-height: 44px !important;
  }

  /* Controls carrying a label: height floor plus room either side, but no width
     floor -- a short label does not need 44px of dead space around it. */
  [data-component="button"],
  [data-component="button-v2"],
  [data-component="split-button-v2-action"],
  [data-component="prompt-model-control"],
  [data-component="prompt-agent-control"],
  [data-component="prompt-variant-control"] {
    min-height: 44px !important;
    padding-left: 12px !important;
    padding-right: 12px !important;
  }

  /* The Session / Changes switcher. Both the track and its items are 28px. */
  [data-slot="segmented-control-v2"],
  [data-component="segmented-control-v2"] {
    height: auto !important;
    min-height: 44px !important;
  }
  [data-slot="segmented-control-v2"] > *,
  [data-component="segmented-control-v2"] > * {
    height: auto !important;
    min-height: 44px !important;
  }

  /* Session tabs. */
  [data-slot="titlebar-tab-item"],
  [data-slot="titlebar-tab-item"] > a,
  [data-slot="titlebar-tab-item"] > button {
    min-height: 44px !important;
  }

  /* Menus and dropdowns are lists you tap, not hover. */
  [data-component="menu-v2-item"],
  [data-component="dropdown-menu-content"] [role="menuitem"],
  [data-component="context-menu-content"] [role="menuitem"],
  [data-component="menu-v2-content"] [role="menuitem"] {
    min-height: 44px !important;
  }

  /* 7b. The composer's control row is the one place the floors above do harm.
         It is a fixed 44px box (h-11) holding four controls on one line inside
         a form with overflow-clip, and the send button is an 'icon-button'
         sized 'size-7' with a tooltip wrapper. Forcing a 44px box on those
         made the send button overflow its slot and paint over the variant
         control ("High"), and clipped its bottom edge against the form.

         So inside the composer the rendered boxes go back to upstream's, and
         the tap area is grown with an inset pseudo-element instead -- 44pt of
         touch with zero layout change. This is the right technique for any
         row that is width-constrained; it is only worth the extra rules here
         because this row is the one that overflowed. */
  [data-component="prompt-input-v2"] [data-component="icon-button"],
  [data-component="prompt-input-v2"] [data-component="icon-button-v2"],
  [data-component="prompt-input-v2"] [data-component="button-v2"],
  [data-component="prompt-input"] [data-component="icon-button"],
  [data-component="prompt-input"] [data-component="icon-button-v2"],
  [data-component="prompt-input"] [data-component="button-v2"] {
    min-width: 0 !important;
    min-height: 0 !important;
    padding-left: 6px !important;
    padding-right: 6px !important;
  }

  /* The invisible tap area. 'position: relative' is already the case for these
     buttons upstream, but assert it so the inset is measured against the
     button rather than an ancestor. */
  [data-action="prompt-submit"],
  [data-action="prompt-attach"],
  [data-action="prompt-model"] {
    position: relative !important;
  }
  [data-action="prompt-submit"]::after,
  [data-action="prompt-attach"]::after,
  [data-action="prompt-model"]::after {
    content: "" !important;
    position: absolute !important;
    inset: -8px !important;
    border-radius: inherit !important;
  }

  /* 7c. The project and session lists -- the drawer you pick a session from.
         Upstream sizes these for a mouse: a project row is 28px (h-7) and a
         session row 40px (h-10). Each also carries absolutely-positioned
         trailing actions, a menu and an edit button, which are IconButtonV2 and
         so were already grown to 44px by the floor above. In a 28px row that
         leaves them overflowing 8px top and bottom onto their neighbours, where
         a tap near a row edge can hit the wrong row's pencil. Growing the rows
         fixes the target size and that overflow together.

         The wrapper has to grow with the button. Each row is a 'relative' div
         whose child button is the same fixed height, so raising only the child
         makes it overflow its own wrapper -- the mistake that put the send
         button on top of the variant control. The trailing actions are centred
         with 'top: 50%' and a translate, so they re-centre for free.

         Wrapper and button share one rule deliberately. A selector list is not
         forgiving: if :has() is unavailable the whole rule drops, so the button
         cannot grow without its wrapper. Degrading to upstream's own sizing is
         fine; degrading to a button overflowing its row is not.

         Left alone: the search field and the sticky group headers. Those are
         placed with hand-tuned pixel offsets derived from the search box's
         height ('top: 84px', 'calc(100cqh - 84px)'), so growing it would
         misalign every sticky header in the list. */
  [data-component="home-project-row"],
  [data-component="home-recently-closed-row"],
  [data-component="home-session-row"],
  [data-component="home-session-search-row"],
  div:has(> [data-component="home-project-row"]),
  div:has(> [data-component="home-recently-closed-row"]),
  div:has(> [data-component="home-session-row"]),
  div:has(> [data-component="home-session-search-row"]) {
    height: auto !important;
    min-height: 44px !important;
  }

  /* 8. Make the glyphs bigger too, so a 44px button is not mostly empty.
        Scoped to direct icon children of these controls, so it cannot resize
        an icon that is deliberately sized elsewhere (the progress spinner, a
        file-type badge). */
  [data-component="icon-button"] > svg,
  [data-component="icon-button-v2"] > svg,
  [data-component="desktop-icon-button"] > svg,
  [data-component="button"] > svg,
  [data-component="button-v2"] > svg,
  [data-component="split-button-v2-action"] > svg,
  [data-component="split-button-v2-menu-trigger"] > svg,
  [data-component="session-tab-popover-trigger"] > svg {
    width: 20px !important;
    height: 20px !important;
  }

  /* 9. Scrolling that behaves like an app rather than a page.
        The timeline should not rubber-band the whole document, and chrome
        should not show a text cursor or a tap-highlight flash. */
  [data-slot="session-turn-content"],
  [data-component="session-turn"] {
    -webkit-overflow-scrolling: touch !important;
    overscroll-behavior: contain !important;
  }
  [data-component="icon-button"],
  [data-component="desktop-icon-button"],
  [data-slot="titlebar-tab-item"],
  [data-component="tabs"],
  [data-oc-strip],
  [data-oc-status] {
    -webkit-tap-highlight-color: transparent !important;
    -webkit-user-select: none !important;
    user-select: none !important;
  }
  /* ...but never disable selection on the content itself: copying a path or an
     error message out of a session is the whole point. */
  [data-component="markdown"],
  [data-component="markdown-code"],
  [data-component="code"],
  [data-component="diff"],
  [data-component="bash-output"],
  [data-component="tool-output"] {
    -webkit-user-select: text !important;
    user-select: text !important;
  }
}

/* ---- now-running status bar ------------------------------------------------
   Rendered by overlay.js, inserted immediately before the composer dock so it
   pins with the dock instead of needing fixed-position offset arithmetic. */

[data-oc-status] {
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 6px 10px;
  border-top: 1px solid var(--border-weaker-base, rgba(127, 127, 127, 0.18));
  background: var(--v2-background-bg-deep, var(--background-base, transparent));
  font-family: var(--font-family-sans, system-ui, sans-serif);
  font-size: 12px;
  line-height: 1.3;
  min-height: 32px;
  color: var(--text-weak, #6b7280);
}

[data-oc-status][hidden] { display: none; }

[data-oc-status] > [data-oc-status-dot] {
  flex: none;
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: currentColor;
}

[data-oc-status] > [data-oc-status-text] {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-weight: 500;
}

[data-oc-status] > [data-oc-status-time] {
  flex: none;
  font-variant-numeric: tabular-nums;
  font-family: ui-monospace, "SF Mono", Menlo, monospace;
  font-size: 11px;
  opacity: 0.75;
}

[data-oc-status][data-oc-state="busy"]      { color: #0c6e68; }
[data-oc-status][data-oc-state="attention"] { color: #a0522a; }
[data-oc-status][data-oc-state="error"]     { color: #a6342a; }

[data-oc-status][data-oc-state="busy"] > [data-oc-status-dot] {
  animation: oc-strip-pulse 1.4s ease-in-out infinite;
}

@media (prefers-reduced-motion: reduce) {
  [data-oc-status][data-oc-state="busy"] > [data-oc-status-dot] { animation: none; }
}

@media (prefers-color-scheme: dark) {
  [data-oc-status][data-oc-state="busy"]      { color: #4ec3b8; }
  [data-oc-status][data-oc-state="attention"] { color: #e0925d; }
  [data-oc-status][data-oc-state="error"]     { color: #e4695d; }
}

/* ---- PWA standalone -------------------------------------------------------
   Installed to the Home Screen, the page runs with no browser chrome. OpenCode
   asks for 'apple-mobile-web-app-status-bar-style: black-translucent' and
   'viewport-fit=cover', which means the document extends UNDER the status bar
   and the home indicator.

   Which padding is ours depends on the layout, and both ship. The v2 layout
   (layout-new.tsx, the one that renders the Session / Changes tabs) already
   sets padding-top and padding-bottom from the insets on its own root, so
   padding #root as well applies them TWICE: on a Dynamic Island phone that is
   roughly 118px of dead black above the titlebar. The legacy layout pads
   nothing and does need it.

   So the vertical inset is gated on a marker only the legacy layout renders,
   and the horizontal one -- which neither layout sets -- is unconditional. If
   :has() is unavailable the gated rule simply drops, which leaves upstream's
   own behaviour rather than a double gap. */
@media (display-mode: standalone), (display-mode: fullscreen) {
  #root {
    padding-left: env(safe-area-inset-left, 0px) !important;
    padding-right: env(safe-area-inset-right, 0px) !important;
  }
  #root:has([data-component="sidebar-nav-mobile"]),
  #root:has([data-component="sidebar-nav-desktop"]) {
    padding-top: env(safe-area-inset-top, 0px) !important;
  }
}

/* ---- keyboard debug readout ------------------------------------------------
   Rendered by overlay.js only when OPENCODE_MOBILE_OVERLAY_DEBUG=1. Styled
   unconditionally so it is never an unstyled string across the screen. */
[data-oc-kbdebug] {
  position: fixed !important;
  left: 0 !important;
  right: 0 !important;
  top: env(safe-area-inset-top, 0px) !important;
  z-index: 2147483647 !important;
  padding: 2px 6px !important;
  background: #0c6e68 !important;
  color: #ffffff !important;
  font: 600 9px/1.4 ui-monospace, "SF Mono", Menlo, monospace !important;
  letter-spacing: .01em !important;
  text-align: center !important;
  pointer-events: none !important;
}

/* ---- keyboard open ---------------------------------------------------------
   Set by overlay.js while the software keyboard is up (see its keyboard
   section). Outside any width media query on purpose: the script decides when
   this applies, and it already restricts itself to a standalone phone.

   iOS never zeroes env(safe-area-inset-bottom) for the keyboard -- the insets
   describe the device, not whatever is covering it -- so the v2 layout goes on
   reserving a strip for a home indicator the keyboard is sitting on top of, and
   the overlay reserves a little more on the dock. Together that is the blank
   band between the composer and the keyboard. With the keyboard up there is no
   home indicator to avoid, so both collapse. */
#root[data-oc-keyboard="open"] > * {
  padding-bottom: 0 !important;
}
#root[data-oc-keyboard="open"] [data-component="dock-prompt"],
#root[data-oc-keyboard="open"] [data-component="session-prompt-dock"],
#root[data-oc-keyboard="open"] [data-component="session-followup-dock"] {
  padding-bottom: 0 !important;
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

/* Sub-agent count. Delegated work shown as "+2" on the parent chip rather than
   as chips of its own: a sub-agent is transient and there can be several at
   once, so its own chip would push the sessions you navigate by off the end of
   a 390pt strip. */
[data-oc-chip] > [data-oc-chip-sub] {
  flex: none;
  padding: 0 5px;
  border-radius: 8px;
  font-size: 11px;
  font-variant-numeric: tabular-nums;
  line-height: 16px;
  background: currentColor;
  /* The chip's own background, punched out of the state colour, so the badge
     reads as a count rather than another status dot. */
  color: var(--background-panel, #1c1c1c);
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
${bubbles}${debugBadge}`;
}
