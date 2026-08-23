import { describe, it, expect, beforeEach } from "vitest";
import * as http from "http";
import { handleOverlayAsset, getOverlayAsset, overlayAssets, clearAssetCache } from "./serve";
import { OVERLAY_CSS_PATH, OVERLAY_JS_PATH, loadOverlayConfig } from "./config";
import type { OverlayConfig } from "./types";

const CONFIG: OverlayConfig = { enabled: true, sessionStrip: true, statusBar: true, maxWidth: 767, debug: false };

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
