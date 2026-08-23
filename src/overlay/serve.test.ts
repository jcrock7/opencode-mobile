import { describe, it, expect, beforeEach } from "vitest";
import * as http from "http";
import { handleOverlayAsset, getOverlayAsset, overlayAssets, clearAssetCache } from "./serve";
import { OVERLAY_CSS_PATH, OVERLAY_JS_PATH, loadOverlayConfig } from "./config";
import type { OverlayConfig } from "./types";

const CONFIG: OverlayConfig = { enabled: true, sessionStrip: true, statusBar: true, keyboardViewport: true, bubbles: true, changesButton: true, maxWidth: 767, debug: false };

/** Remove every balanced @media block, leaving only unconditional rules. */
function stripMediaBlocks(css: string): string {
  let out = "";
  let i = 0;
  while (i < css.length) {
    const at = css.indexOf("@media", i);
    if (at === -1) {
      out += css.slice(i);
      break;
    }
    out += css.slice(i, at);
    const open = css.indexOf("{", at);
    if (open === -1) break;
    let depth = 1;
    let j = open + 1;
    while (j < css.length && depth > 0) {
      if (css[j] === "{") depth++;
      else if (css[j] === "}") depth--;
      j++;
    }
    i = j;
  }
  return out;
}

interface Captured {
  status: number;
  headers: Record<string, string>;
  body: string;
}

function fakeReq(method: string, headers: http.IncomingHttpHeaders = {}): http.IncomingMessage {
  return { method, headers } as http.IncomingMessage;
}

function fakeRes(): { res: http.ServerResponse; captured: Captured } {
  const captured: Captured = { status: 0, headers: {}, body: "" };
  const res = {
    writeHead(status: number, headers?: Record<string, string>) {
      captured.status = status;
      if (headers) captured.headers = { ...headers };
      return this;
    },
    end(body?: string) {
      if (body) captured.body = body;
      return this;
    },
  } as unknown as http.ServerResponse;
  return { res, captured };
}

describe("overlay assets", () => {
  beforeEach(() => clearAssetCache());

  it("builds both assets", () => {
    const assets = overlayAssets(CONFIG);
    expect(assets.has(OVERLAY_CSS_PATH)).toBe(true);
    expect(assets.has(OVERLAY_JS_PATH)).toBe(true);
  });

  it("memoises per config", () => {
    expect(overlayAssets(CONFIG)).toBe(overlayAssets(CONFIG));
  });

  it("rebuilds for a different breakpoint", () => {
    const a = getOverlayAsset(OVERLAY_CSS_PATH, CONFIG);
    const b = getOverlayAsset(OVERLAY_CSS_PATH, { ...CONFIG, maxWidth: 900 });
    expect(a?.body).not.toBe(b?.body);
    expect(a?.etag).not.toBe(b?.etag);
  });

  describe("the stylesheet", () => {
    it("scopes the mobile rules to the configured breakpoint", () => {
      const css = getOverlayAsset(OVERLAY_CSS_PATH, CONFIG)!.body;
      expect(css).toContain("@media (max-width: 767px)");
    });

    it("un-truncates the slots the timeline ellipsises", () => {
      const css = getOverlayAsset(OVERLAY_CSS_PATH, CONFIG)!.body;
      for (const slot of [
        "message-part-title-filename",
        "message-part-directory",
        "basic-tool-tool-subtitle",
        "apply-patch-filename",
        "apply-patch-directory",
      ]) {
        expect(css).toContain(`[data-slot="${slot}"]`);
      }
      expect(css).toContain("white-space: normal !important");
    });

    it("uses !important, since the upstream rules are nested and win otherwise", () => {
      const css = getOverlayAsset(OVERLAY_CSS_PATH, CONFIG)!.body;
      expect(css).toContain("font-size: 16px !important");
    });

    it("styles the strip and status bar outside any media query", () => {
      const css = getOverlayAsset(OVERLAY_CSS_PATH, CONFIG)!.body;
      // Both are rendered by the script, which mounts them only on narrow
      // viewports -- so their own styles must not be width-gated as well, or a
      // rotation or a tablet leaves them unstyled. Strip every @media block and
      // check the base rules survive.
      const unconditional = stripMediaBlocks(css);
      expect(unconditional).toContain("[data-oc-strip] {");
      expect(unconditional).toContain("[data-oc-chip] {");
      expect(unconditional).toContain("[data-oc-status] {");
      expect(unconditional).toContain("[data-oc-status][hidden]");
    });

    it("omits the debug badge unless asked", () => {
      const css = getOverlayAsset(OVERLAY_CSS_PATH, CONFIG)!.body;
      expect(css).not.toContain("oc-mobile overlay active");
    });

    it("emits the debug badge when enabled, scoped to the breakpoint", () => {
      const css = getOverlayAsset(OVERLAY_CSS_PATH, { ...CONFIG, debug: true })!.body;
      expect(css).toContain("oc-mobile overlay active (<= 767px)");
      expect(css).toContain("pointer-events: none !important");
    });

    it("rebuilds the asset when only debug changes", () => {
      const plain = getOverlayAsset(OVERLAY_CSS_PATH, CONFIG)!;
      const debug = getOverlayAsset(OVERLAY_CSS_PATH, { ...CONFIG, debug: true })!;
      expect(debug.body).not.toBe(plain.body);
      expect(debug.etag).not.toBe(plain.etag);
    });

    it("pads the app shell for the notch when running standalone", () => {
      const css = getOverlayAsset(OVERLAY_CSS_PATH, CONFIG)!.body;
      expect(css).toContain("@media (display-mode: standalone)");
      expect(css).toContain("padding-top: env(safe-area-inset-top, 0px) !important");
      // The shell, not one component -- upstream has two layouts.
      expect(css).toMatch(/#root\s*\{/);
    });

    it("does not double-pad the top inset on the layout that pads itself", () => {
      // layout-new.tsx sets padding-top/bottom from the insets on its own root.
      // Padding #root unconditionally applied them twice, which on a Dynamic
      // Island phone left ~118px of dead black above the titlebar. The vertical
      // inset is gated on a marker only the legacy layout renders.
      const css = getOverlayAsset(OVERLAY_CSS_PATH, CONFIG)!.body;
      expect(css).toContain('#root:has([data-component="sidebar-nav-mobile"])');
      // No bare `#root { ... padding-top ... }` anywhere.
      expect(css).not.toMatch(/#root\s*\{[^}]*padding-top/);
    });

    it("keeps the horizontal insets unconditional", () => {
      // Neither layout sets these, so they are always ours to apply.
      const css = getOverlayAsset(OVERLAY_CSS_PATH, CONFIG)!.body;
      expect(css).toMatch(/#root\s*\{[^}]*padding-left: env\(safe-area-inset-left/);
    });

    it("does not double-pad the composer for the home indicator either", () => {
      const css = getOverlayAsset(OVERLAY_CSS_PATH, CONFIG)!.body;
      // Flat 8px by default; the inset only on the layout that pads nothing.
      expect(css).toMatch(
        /\[data-component="session-prompt-dock"\],[\s\S]{0,200}padding-bottom: 8px !important/,
      );
      expect(css).toMatch(
        /#root:has\(\[data-component="sidebar-nav-mobile"\]\) \[data-component="dock-prompt"\]/,
      );
    });

    it("leaves the composer control boxes at upstream's size", () => {
      // The footer row is a fixed 44px box holding four controls on one line
      // inside a form with overflow-clip. Forcing 44px boxes there made the
      // send button overflow its slot and paint over the variant control.
      const css = getOverlayAsset(OVERLAY_CSS_PATH, CONFIG)!.body;
      expect(css).toMatch(
        /\[data-component="prompt-input-v2"\] \[data-component="icon-button"\][\s\S]{0,600}min-width: 0 !important/,
      );
    });

    it("styles upstream's own user bubble rather than adding a second one", () => {
      // Upstream already draws it: the container is a flex column with
      // align-items: flex-end and [data-slot="user-message-text"] carries the
      // background, padding and radius. Boxing the row on top of that produced
      // a bubble inside a bubble.
      const css = getOverlayAsset(OVERLAY_CSS_PATH, CONFIG)!.body;
      expect(css).toContain('[data-component="user-message"] [data-slot="user-message-text"]');
      // Asymmetric radius is the tail; a pseudo-element triangle would have to
      // know the bubble's background and break on a theme change.
      expect(css).toContain("border-radius: 14px 14px 4px 14px !important");
    });

    it("never gives the user's row a box of its own", () => {
      // The regression guard for the double bubble.
      const css = getOverlayAsset(OVERLAY_CSS_PATH, CONFIG)!.body;
      expect(css).not.toContain('[data-timeline-row="UserMessage"] [data-slot="session-turn-message-content"]');
      expect(css).not.toMatch(/\[data-timeline-row="UserMessage"\][^{]*\{[^}]*background:/);
    });

    it("rails the response rather than boxing each part", () => {
      // There is no element wrapping a whole response, so the rail is a
      // border-left per row. Consecutive assistant rows butt together into a
      // continuous line; a TurnGap row has no border, so it breaks at the turn.
      const css = getOverlayAsset(OVERLAY_CSS_PATH, CONFIG)!.body;
      for (const tag of ["AssistantPart", "Thinking", "DiffSummary", "Error", "Retry"]) {
        expect(css).toContain(`[data-timeline-row="${tag}"]`);
      }
      expect(css).toMatch(/border-left: 2px solid/);
      // Never on the user's row -- that would rail the bubble too.
      expect(css).not.toMatch(
        /\[data-timeline-row="UserMessage"\],[\s\S]{0,200}border-left: 2px/,
      );
    });

    it("keeps the response full width", () => {
      // Prose, code and diffs all need the room; only the user's bubble is
      // inset. A max-width on the assistant rows would undo the scrollable
      // code work.
      const css = getOverlayAsset(OVERLAY_CSS_PATH, CONFIG)!.body;
      expect(css).not.toMatch(
        /\[data-timeline-row="AssistantPart"\][\s\S]{0,300}max-width:/,
      );
    });

    it("colours only the rows that are actually a problem", () => {
      const css = getOverlayAsset(OVERLAY_CSS_PATH, CONFIG)!.body;
      expect(css).toMatch(
        /\[data-timeline-row="Error"\],\s*\n\s*\[data-timeline-row="Retry"\]\s*\{[^}]*border-left-color/,
      );
    });

    it("demotes tool rows to a subdued card", () => {
      const css = getOverlayAsset(OVERLAY_CSS_PATH, CONFIG)!.body;
      expect(css).toMatch(
        /\[data-component="tool-trigger"\]\s*\{[^}]*background: var\(--v2-background-bg-layer-01/,
      );
    });

    it("uses upstream's own theme tokens, so both themes work", () => {
      // Hard-coded colours would look wrong in the light theme, which the
      // overlay has no way to detect from a stylesheet.
      const css = getOverlayAsset(OVERLAY_CSS_PATH, CONFIG)!.body;
      // The bubble's own background is upstream's; what the overlay adds is the
      // hairline and the tool-row surface, and both come from tokens.
      expect(css).toContain("var(--v2-border-border-muted");
      expect(css).toContain("var(--v2-background-bg-layer-01");
    });

    it("omits the tiers entirely when switched off", () => {
      const css = getOverlayAsset(OVERLAY_CSS_PATH, { ...CONFIG, bubbles: false })!.body;
      // The row hooks are used by nothing else, so they go completely.
      expect(css).not.toContain("data-timeline-row");
      expect(css).not.toContain("border-left: 2px solid");
      // tool-trigger stays: the un-truncation rules use it too, and those are
      // not part of this switch.
      expect(css).toContain('[data-component="tool-trigger"]');
      expect(css).not.toMatch(
        /\[data-component="tool-trigger"\]\s*\{[^}]*background: var\(--v2-background-bg-layer-01/,
      );
    });

    it("rebuilds the asset when only the tiers change", () => {
      const on = getOverlayAsset(OVERLAY_CSS_PATH, CONFIG)!;
      const off = getOverlayAsset(OVERLAY_CSS_PATH, { ...CONFIG, bubbles: false })!;
      expect(off.body).not.toBe(on.body);
      expect(off.etag).not.toBe(on.etag);
    });

    it("makes the settings dialog a full screen, not a floating card", () => {
      // Upstream caps x-large at min(100vh - 92px, 600px), so on an 852pt phone
      // it stopped at 600 and floated in a band of dead space.
      const css = getOverlayAsset(OVERLAY_CSS_PATH, CONFIG)!.body;
      expect(css).toContain('[data-component="dialog-v2"][data-size="x-large"]');
      expect(css).toMatch(/\[data-slot="dialog-container"\]\s*\{[^}]*height: 100% !important/);
      expect(css).toMatch(/\[data-slot="dialog-container"\]\s*\{[^}]*border-radius: 0 !important/);
    });

    it("never makes the full-screen dialog container a click target", () => {
      // The container and its wrapper are always in the DOM -- only the content
      // inside them mounts and unmounts -- so a viewport-sized container with
      // upstream's pointer-events: auto is an invisible full-screen click
      // shield over the whole app.
      const css = getOverlayAsset(OVERLAY_CSS_PATH, CONFIG)!.body;
      expect(css).toMatch(
        /\[data-slot="dialog-container"\]\s*\{[^}]*pointer-events: none !important/,
      );
      expect(css).toMatch(
        /\[data-slot="dialog-content"\]\s*\{[^}]*pointer-events: auto !important/,
      );
    });

    it("pads the settings dialog for the insets itself", () => {
      // It is portalled outside the app shell, so the padding the overlay puts
      // on #root never reaches it.
      const css = getOverlayAsset(OVERLAY_CSS_PATH, CONFIG)!.body;
      expect(css).toMatch(
        /\[data-slot="dialog-container"\]\s*\{[^}]*padding-top: env\(safe-area-inset-top/,
      );
    });

    it("narrows the settings nav so the content column is readable", () => {
      // 150px of a 393pt screen left descriptions wrapping after two words.
      const css = getOverlayAsset(OVERLAY_CSS_PATH, CONFIG)!.body;
      expect(css).toMatch(
        /\.settings-v2 \[data-slot="tabs-list"\]\s*\{[^}]*min-width: 112px !important/,
      );
    });

    it("replaces the settings gutters with phone-sized ones", () => {
      const css = getOverlayAsset(OVERLAY_CSS_PATH, CONFIG)!.body;
      expect(css).toMatch(/\.settings-v2-tab-header\s*\{[^}]*padding: 16px 16px 12px !important/);
      expect(css).toMatch(/\.settings-v2-tab-body\s*\{[^}]*padding: 0 16px 16px !important/);
    });

    it("keeps the settings rules behind the phone breakpoint", () => {
      // A 112px nav and a full-bleed dialog are wrong on a desktop.
      const css = getOverlayAsset(OVERLAY_CSS_PATH, CONFIG)!.body;
      const unconditional = stripMediaBlocks(css);
      expect(unconditional).not.toContain("settings-v2-tab-header");
      expect(unconditional).not.toContain('[data-size="x-large"]');
    });

    it("keeps the settings rules when the transcript tiers are off", () => {
      // They are separate concerns; the bubbles switch is about the transcript.
      const css = getOverlayAsset(OVERLAY_CSS_PATH, { ...CONFIG, bubbles: false })!.body;
      expect(css).toContain("settings-v2-tab-header");
      expect(css).toContain('[data-size="x-large"]');
    });

    it("hides the Session / Changes tab bar without removing it", () => {
      // display: none on the list keeps the triggers in the DOM and clickable,
      // which is the whole mechanism -- the script drives them.
      const css = getOverlayAsset(OVERLAY_CSS_PATH, CONFIG)!.body;
      expect(css).toContain(
        '[data-slot="tabs-list"]:has([data-value="session"]):has([data-value="changes"])',
      );
      // Scoped by the pair: the settings dialog and the file tabs are lists too.
      expect(css).not.toMatch(/\[data-slot="tabs-list"\]\s*\{[^}]*display: none/);
    });

    it("styles the changes button as a 44px target with a count badge", () => {
      const css = getOverlayAsset(OVERLAY_CSS_PATH, CONFIG)!.body;
      expect(css).toMatch(/\[data-oc-changes\]\s*\{[^}]*min-height: 44px !important/);
      expect(css).toContain("[data-oc-changes] > [data-oc-changes-count]");
      expect(css).toMatch(
        /\[data-oc-changes-count\]\s*\{[^}]*pointer-events: none !important/,
      );
    });

    it("omits the tab-bar rules when the changes button is off", () => {
      // Hiding the bar with no replacement would strand the diff view.
      const css = getOverlayAsset(OVERLAY_CSS_PATH, { ...CONFIG, changesButton: false })!.body;
      expect(css).not.toContain('[data-value="changes"]');
      expect(css).not.toContain("[data-oc-changes]");
    });

    it("collapses the bottom safe-area inset while the keyboard is open", () => {
      // iOS never zeroes env(safe-area-inset-bottom) for the keyboard, so the
      // layout keeps reserving a strip for a home indicator the keyboard is
      // covering. That strip is the blank band above the keyboard.
      const css = getOverlayAsset(OVERLAY_CSS_PATH, CONFIG)!.body;
      expect(css).toContain('#root[data-oc-keyboard="open"] > *');
      expect(css).toMatch(
        /#root\[data-oc-keyboard="open"\] > \*\s*\{[^}]*padding-bottom: 0 !important/,
      );
      // The dock adds its own; that has to go too or the band just shrinks.
      expect(css).toContain('#root[data-oc-keyboard="open"] [data-component="session-prompt-dock"]');
    });

    it("styles the keyboard rules outside any width media query", () => {
      // The script decides when they apply -- it already limits itself to a
      // standalone phone -- so width-gating them as well would double-gate.
      const css = getOverlayAsset(OVERLAY_CSS_PATH, CONFIG)!.body;
      const unconditional = stripMediaBlocks(css);
      expect(unconditional).toContain('#root[data-oc-keyboard="open"] > *');
    });

    it("styles the debug readout even though only debug renders it", () => {
      // Never an unstyled string of numbers across the screen.
      const css = getOverlayAsset(OVERLAY_CSS_PATH, CONFIG)!.body;
      expect(css).toContain("[data-oc-kbdebug]");
      expect(css).toMatch(/\[data-oc-kbdebug\]\s*\{[^}]*pointer-events: none !important/);
    });

    it("grows the project and session rows you pick a session from", () => {
      const css = getOverlayAsset(OVERLAY_CSS_PATH, CONFIG)!.body;
      for (const row of [
        "home-project-row",
        "home-recently-closed-row",
        "home-session-row",
        "home-session-search-row",
      ]) {
        expect(css).toContain(`[data-component="${row}"]`);
      }
    });

    it("grows each row's wrapper with it, in the same rule", () => {
      // Each row is a fixed-height div wrapping a button of the same height, so
      // raising only the button makes it overflow its own wrapper. And a
      // selector list is not forgiving: sharing one rule means that where
      // :has() is unavailable the whole thing drops, rather than leaving the
      // button grown and the wrapper not.
      const css = getOverlayAsset(OVERLAY_CSS_PATH, CONFIG)!.body;
      const rule = /\[data-component="home-project-row"\][\s\S]*?\}/.exec(css)?.[0] ?? "";
      expect(rule).toContain('div:has(> [data-component="home-project-row"])');
      expect(rule).toContain('div:has(> [data-component="home-session-row"])');
      expect(rule).toContain("min-height: 44px !important");
      // height: auto as well -- the wrappers set an explicit h-7 / h-10.
      expect(rule).toContain("height: auto !important");
    });

    it("leaves the session search field and sticky headers alone", () => {
      // Their geometry is hand-tuned pixel offsets derived from the search
      // box's height, so growing it misaligns every sticky group header.
      const css = getOverlayAsset(OVERLAY_CSS_PATH, CONFIG)!.body;
      expect(css).not.toContain('[data-component="home-session-search"]');
      expect(css).not.toContain('[data-component="home-session-search-panel"]');
      expect(css).not.toContain('[data-component="home-session-scroll-track"]');
    });

    it("grows the composer tap areas without growing their boxes", () => {
      // An inset pseudo-element gives 44pt of touch with zero layout change --
      // the only way to do it in a width-constrained row.
      const css = getOverlayAsset(OVERLAY_CSS_PATH, CONFIG)!.body;
      for (const action of ["prompt-submit", "prompt-attach", "prompt-model"]) {
        expect(css).toContain(`[data-action="${action}"]::after`);
      }
      expect(css).toMatch(/\[data-action="prompt-submit"\]::after[\s\S]{0,300}inset: -8px !important/);
    });

    it("pads the composer for the home indicator, whichever dock is in use", () => {
      const css = getOverlayAsset(OVERLAY_CSS_PATH, CONFIG)!.body;
      for (const dock of ["dock-prompt", "session-prompt-dock", "session-followup-dock"]) {
        expect(css).toContain(`[data-component="${dock}"]`);
      }
      expect(css).toContain("env(safe-area-inset-bottom)");
    });

    it("gives chrome controls a 44px hit area", () => {
      const css = getOverlayAsset(OVERLAY_CSS_PATH, CONFIG)!.body;
      expect(css).toContain('[data-component="icon-button"]');
      expect(css).toContain("min-height: 44px !important");
    });

    it("raises the v2 controls too, not just their v1 namesakes", () => {
      // Upstream ships two generations of every control and the phone build
      // renders the v2 set. An earlier version of the touch-target rule named
      // only the v1 selectors, so it changed almost nothing on a real session.
      const css = getOverlayAsset(OVERLAY_CSS_PATH, CONFIG)!.body;
      for (const component of [
        "icon-button-v2",
        "button-v2",
        "split-button-v2-action",
        "split-button-v2-menu-trigger",
        "menu-v2-item",
        "accordion-v2-trigger",
      ]) {
        expect(css).toContain(`[data-component="${component}"]`);
      }
    });

    it("widens the icon buttons as well as heightening them", () => {
      // IconButton sets an explicit square size, so a height floor on its own
      // produces a tall thin sliver instead of a bigger target.
      const css = getOverlayAsset(OVERLAY_CSS_PATH, CONFIG)!.body;
      expect(css).toMatch(
        /\[data-component="icon-button-v2"\][\s\S]{0,400}min-width: 44px !important/,
      );
    });

    it("lets the titlebar grow to hold a 44px control", () => {
      // The non-v2 titlebar is a 40px box with overflow: hidden, which would
      // clip a taller button rather than show it.
      const css = getOverlayAsset(OVERLAY_CSS_PATH, CONFIG)!.body;
      expect(css).toMatch(/header\s*\{[\s\S]{0,200}overflow: visible !important/);
      expect(css).toMatch(/header\s*\{[\s\S]{0,200}height: auto !important/);
    });

    it("raises the Session / Changes switcher, track and items alike", () => {
      // The track sets its own 28px height, so the items cannot outgrow it
      // unless the track is released too.
      const css = getOverlayAsset(OVERLAY_CSS_PATH, CONFIG)!.body;
      expect(css).toContain('[data-slot="segmented-control-v2"] > *');
      expect(css).toMatch(
        /\[data-slot="segmented-control-v2"\],[\s\S]{0,200}min-height: 44px !important/,
      );
    });

    it("scales the glyphs to match, without touching icons sized elsewhere", () => {
      const css = getOverlayAsset(OVERLAY_CSS_PATH, CONFIG)!.body;
      expect(css).toContain('[data-component="icon-button-v2"] > svg');
      expect(css).toContain("width: 20px !important");
      // Direct children only: a descendant selector here would also resize the
      // progress spinner and the file-type badges.
      expect(css).not.toContain('[data-component="icon-button-v2"] svg,');
    });

    it("keeps the touch targets behind the phone breakpoint", () => {
      // A 48px titlebar and 44px buttons are a phone affordance; forcing them
      // on a desktop viewport would just make the chrome clumsy.
      const css = getOverlayAsset(OVERLAY_CSS_PATH, CONFIG)!.body;
      const unconditional = stripMediaBlocks(css);
      expect(unconditional).not.toContain("min-height: 44px !important");
      expect(unconditional).not.toMatch(/header\s*\{/);
    });

    it("contains overscroll to the timeline", () => {
      const css = getOverlayAsset(OVERLAY_CSS_PATH, CONFIG)!.body;
      expect(css).toContain("overscroll-behavior: contain !important");
    });

    it("keeps content selectable while making chrome unselectable", () => {
      const css = getOverlayAsset(OVERLAY_CSS_PATH, CONFIG)!.body;
      // Copying a path or a stack trace out of a session must keep working.
      expect(css).toMatch(/\[data-component="markdown"\][\s\S]{0,400}user-select: text/);
    });

    it("styles all four status-bar states", () => {
      const css = getOverlayAsset(OVERLAY_CSS_PATH, CONFIG)!.body;
      for (const state of ["busy", "attention", "error"]) {
        expect(css).toContain(`[data-oc-status][data-oc-state="${state}"]`);
      }
      expect(css).toContain("[data-oc-status][hidden]");
    });

    it("does not hide the sidebar rail", () => {
      // The persistent sidebar is already `hidden xl:block` upstream, so the
      // only rail on a phone is the one inside the drawer -- and that one
      // carries the project avatars and the open-project button. Hiding it
      // removed the drawer's navigation and gained nothing.
      const css = getOverlayAsset(OVERLAY_CSS_PATH, CONFIG)!.body;
      expect(css).not.toMatch(/\[data-component="sidebar-rail"\]\s*\{[^}]*display:\s*none/);
    });

    it("covers all four session states", () => {
      const css = getOverlayAsset(OVERLAY_CSS_PATH, CONFIG)!.body;
      for (const state of ["busy", "attention", "error", "idle"]) {
        expect(css).toContain(`[data-oc-state="${state}"]`);
      }
    });
  });

  describe("the script's template escaping", () => {
    // The script is written inside a template literal, and the two kinds of
    // backslash behave differently there:
    //
    //   valid escape   (\u, \n, \\)  resolves at build time. The emitted script
    //                                carries the character, and works.
    //   invalid escape (\d, \s, \w)  silently loses its backslash.
    //
    // The second shipped once: the changed-file badge read /\d+/ in the source,
    // emitted /d+/, and matched the "d" in "changed", so the badge said "d".
    // Anything the browser must see as a backslash has to be doubled.
    //
    // These read the built asset rather than the source, which is the only way
    // to see what the browser actually gets.

    it("emits a real digit class in the changed-file count", () => {
      const js = getOverlayAsset(OVERLAY_JS_PATH, CONFIG)!.body;
      expect(js).toContain("/\\d+/");
      expect(js).not.toMatch(/\/d\+\//);
    });

    it("emits no regex literal that lost its escape", () => {
      // A character class or escape that survived as a bare letter.
      const js = getOverlayAsset(OVERLAY_JS_PATH, CONFIG)!.body;
      for (const bad of ["/d+/", "/w+/", "/s+/", "/D+/", "/W+/", "/S+/"]) {
        expect(js).not.toContain(bad);
      }
    });

    it("resolves a valid escape at build time, which is harmless", () => {
      // The rule is narrower than "double every backslash". A VALID template
      // escape -- \u, \n, \\ -- resolves when the module is evaluated, so the
      // emitted script carries the character itself and works. Only an INVALID
      // one silently loses its backslash, which is what bit the digit class.
      const js = getOverlayAsset(OVERLAY_JS_PATH, CONFIG)!.body;
      expect(js).toContain("\u00b7");
    });

    it("emits a valid script", () => {
      // The cheapest possible check that the whole template still parses.
      const js = getOverlayAsset(OVERLAY_JS_PATH, CONFIG)!.body;
      expect(() => new Function(js)).not.toThrow();
    });
  });

  describe("the script", () => {
    it("bakes in the configured breakpoint", () => {
      const js = getOverlayAsset(OVERLAY_JS_PATH, CONFIG)!.body;
      expect(js).toContain("var MAX_WIDTH = 767;");
      expect(js).toContain("var STRIP_ENABLED = true;");
      expect(js).toContain("var STATUS_ENABLED = true;");
    });

    it("compiles to valid JavaScript", () => {
      const js = getOverlayAsset(OVERLAY_JS_PATH, CONFIG)!.body;
      // Throws a SyntaxError if the generated source does not parse.
      expect(() => new Function(js)).not.toThrow();
    });

    it("reads the endpoints it claims to and writes nothing", () => {
      const js = getOverlayAsset(OVERLAY_JS_PATH, CONFIG)!.body;
      expect(js).toContain('getJson("/session")');
      expect(js).toContain('getJson("/session/status")');
      expect(js).toContain('EventSource("/event"');
      expect(js).not.toContain('method: "POST"');
      expect(js).not.toContain('method: "DELETE"');
    });

    it("reflects each switch independently", () => {
      const noStrip = getOverlayAsset(OVERLAY_JS_PATH, { ...CONFIG, sessionStrip: false })!.body;
      expect(noStrip).toContain("var STRIP_ENABLED = false;");
      expect(noStrip).toContain("var STATUS_ENABLED = true;");

      const noStatus = getOverlayAsset(OVERLAY_JS_PATH, { ...CONFIG, statusBar: false })!.body;
      expect(noStatus).toContain("var STRIP_ENABLED = true;");
      expect(noStatus).toContain("var STATUS_ENABLED = false;");
    });
  });

  describe("handleOverlayAsset", () => {
    it("returns false for a path it does not own", () => {
      const { res } = fakeRes();
      expect(handleOverlayAsset("/session", fakeReq("GET"), res, CONFIG)).toBe(false);
    });

    it("serves the stylesheet with the right content type", () => {
      const { res, captured } = fakeRes();
      expect(handleOverlayAsset(OVERLAY_CSS_PATH, fakeReq("GET"), res, CONFIG)).toBe(true);
      expect(captured.status).toBe(200);
      expect(captured.headers["content-type"]).toBe("text/css; charset=utf-8");
      expect(captured.body).toContain("@media");
    });

    it("serves the script with the right content type", () => {
      const { res, captured } = fakeRes();
      handleOverlayAsset(OVERLAY_JS_PATH, fakeReq("GET"), res, CONFIG);
      expect(captured.headers["content-type"]).toBe("text/javascript; charset=utf-8");
    });

    it("sets an accurate byte length for multi-byte content", () => {
      const { res, captured } = fakeRes();
      handleOverlayAsset(OVERLAY_CSS_PATH, fakeReq("GET"), res, CONFIG);
      expect(Number(captured.headers["content-length"])).toBe(Buffer.byteLength(captured.body));
    });

    it("answers a matching If-None-Match with 304 and no body", () => {
      const etag = getOverlayAsset(OVERLAY_CSS_PATH, CONFIG)!.etag;
      const { res, captured } = fakeRes();
      handleOverlayAsset(OVERLAY_CSS_PATH, fakeReq("GET", { "if-none-match": etag }), res, CONFIG);
      expect(captured.status).toBe(304);
      expect(captured.body).toBe("");
    });

    it("serves the body when the ETag does not match", () => {
      const { res, captured } = fakeRes();
      handleOverlayAsset(OVERLAY_CSS_PATH, fakeReq("GET", { "if-none-match": 'W/"stale"' }), res, CONFIG);
      expect(captured.status).toBe(200);
      expect(captured.body.length).toBeGreaterThan(0);
    });

    it("answers HEAD with headers and no body", () => {
      const { res, captured } = fakeRes();
      handleOverlayAsset(OVERLAY_CSS_PATH, fakeReq("HEAD"), res, CONFIG);
      expect(captured.status).toBe(200);
      expect(captured.body).toBe("");
      expect(captured.headers["content-length"]).toBeDefined();
    });

    it("rejects a write method", () => {
      const { res, captured } = fakeRes();
      handleOverlayAsset(OVERLAY_CSS_PATH, fakeReq("POST"), res, CONFIG);
      expect(captured.status).toBe(405);
      expect(captured.headers["allow"]).toBe("GET, HEAD");
    });
  });

  it("serves assets built from the ambient env config", () => {
    const config = loadOverlayConfig({});
    expect(getOverlayAsset(OVERLAY_CSS_PATH, config)).not.toBeNull();
  });
});
