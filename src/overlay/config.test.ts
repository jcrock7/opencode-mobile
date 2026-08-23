import { describe, it, expect } from "vitest";
import {
  loadOverlayConfig,
  isOverlayAssetPath,
  pathnameOf,
  DEFAULT_MAX_WIDTH,
  OVERLAY_CSS_PATH,
  OVERLAY_JS_PATH,
} from "./config";

describe("overlay config", () => {
  describe("loadOverlayConfig", () => {
    it("enables the overlay by default", () => {
      const config = loadOverlayConfig({});
      expect(config).toEqual({
        enabled: true,
        sessionStrip: true,
        statusBar: true,
        keyboardViewport: true,
        maxWidth: DEFAULT_MAX_WIDTH,
        debug: false,
      });
    });

    it.each(["0", "false", "off", "no", "OFF", " False "])("treats %s as disabled", (value) => {
      expect(loadOverlayConfig({ OPENCODE_MOBILE_OVERLAY: value }).enabled).toBe(false);
    });

    it.each(["1", "true", "on", "yes", ""])("leaves the overlay enabled for %s", (value) => {
      expect(loadOverlayConfig({ OPENCODE_MOBILE_OVERLAY: value }).enabled).toBe(true);
    });

    it("disables only the keyboard viewport fix independently", () => {
      const config = loadOverlayConfig({ OPENCODE_MOBILE_OVERLAY_KEYBOARD: "0" });
      expect(config.enabled).toBe(true);
      expect(config.sessionStrip).toBe(true);
      expect(config.statusBar).toBe(true);
      expect(config.keyboardViewport).toBe(false);
    });

    it("disables only the status bar independently", () => {
      const config = loadOverlayConfig({ OPENCODE_MOBILE_OVERLAY_STATUS: "0" });
      expect(config.enabled).toBe(true);
      expect(config.sessionStrip).toBe(true);
      expect(config.statusBar).toBe(false);
    });

    it("disables only the strip independently", () => {
      const config = loadOverlayConfig({ OPENCODE_MOBILE_OVERLAY_STRIP: "0" });
      expect(config.enabled).toBe(true);
      expect(config.sessionStrip).toBe(false);
    });

    it("leaves the debug badge off by default", () => {
      expect(loadOverlayConfig({}).debug).toBe(false);
    });

    it.each(["1", "true", "on", "yes", "TRUE"])("enables debug for %s", (value) => {
      expect(loadOverlayConfig({ OPENCODE_MOBILE_OVERLAY_DEBUG: value }).debug).toBe(true);
    });

    it.each(["0", "false", "off", "", "maybe"])("leaves debug off for %s", (value) => {
      expect(loadOverlayConfig({ OPENCODE_MOBILE_OVERLAY_DEBUG: value }).debug).toBe(false);
    });

    it("accepts a custom breakpoint", () => {
      expect(loadOverlayConfig({ OPENCODE_MOBILE_OVERLAY_MAX_WIDTH: "900" }).maxWidth).toBe(900);
    });

    it("floors a fractional breakpoint", () => {
      expect(loadOverlayConfig({ OPENCODE_MOBILE_OVERLAY_MAX_WIDTH: "820.7" }).maxWidth).toBe(820);
    });

    it.each(["abc", "", "10", "99999", "-500"])("ignores the nonsense breakpoint %s", (value) => {
      expect(loadOverlayConfig({ OPENCODE_MOBILE_OVERLAY_MAX_WIDTH: value }).maxWidth).toBe(
        DEFAULT_MAX_WIDTH,
      );
    });
  });

  describe("isOverlayAssetPath", () => {
    it("matches both asset routes", () => {
      expect(isOverlayAssetPath(OVERLAY_CSS_PATH)).toBe(true);
      expect(isOverlayAssetPath(OVERLAY_JS_PATH)).toBe(true);
    });

    it("rejects anything else", () => {
      expect(isOverlayAssetPath("/")).toBe(false);
      expect(isOverlayAssetPath("/session")).toBe(false);
      expect(isOverlayAssetPath("/__oc-mobile/")).toBe(false);
      expect(isOverlayAssetPath(`${OVERLAY_CSS_PATH}/extra`)).toBe(false);
    });
  });

  describe("pathnameOf", () => {
    it("strips a query string", () => {
      expect(pathnameOf("/session?directory=/tmp")).toBe("/session");
    });

    it("strips a hash", () => {
      expect(pathnameOf("/session#msg_1")).toBe("/session");
    });

    it("strips a query that precedes a hash", () => {
      expect(pathnameOf("/a?b=1#c")).toBe("/a");
    });

    it("leaves a bare path alone", () => {
      expect(pathnameOf("/event")).toBe("/event");
    });
  });
});
