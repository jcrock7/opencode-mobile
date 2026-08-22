import { describe, it, expect } from "vitest";
import { routeRequest } from "./route";
import { OVERLAY_CSS_PATH, OVERLAY_JS_PATH } from "../overlay/config";

const route = (pathname: string, method = "GET", overlayEnabled = true) =>
  routeRequest({ pathname, method, overlayEnabled }).kind;

describe("routeRequest", () => {
  describe("the plugin's own endpoints stay local", () => {
    it.each(["/push-token", "/push-token/", "/push-token/extra"])("%s", (p) => {
      expect(route(p)).toBe("push-token");
    });

    it.each(["/tunnel", "/tunnel/", "/tunnel/status"])("%s", (p) => {
      expect(route(p)).toBe("tunnel");
    });
  });

  describe("overlay assets", () => {
    it("serves the stylesheet and script", () => {
      expect(route(OVERLAY_CSS_PATH)).toBe("overlay-asset");
      expect(route(OVERLAY_JS_PATH)).toBe("overlay-asset");
    });

    it("forwards them upstream when the overlay is disabled", () => {
      expect(route(OVERLAY_CSS_PATH, "GET", false)).toBe("forward");
      expect(route(OVERLAY_JS_PATH, "GET", false)).toBe("forward");
    });
  });

  describe("everything else reaches OpenCode", () => {
    it.each([
      "/",
      "/session",
      "/session/ses_1",
      "/session/status",
      "/session/ses_1/message",
      "/event",
      "/assets/index-abc123.js",
      "/favicon-v3.svg",
      "/site.webmanifest",
      "/oc-theme-preload.js",
      "/__oc-mobile/other.css",
    ])("%s", (p) => {
      expect(route(p)).toBe("forward");
    });
  });

  describe("prefix matching is segment-aware", () => {
    // These start with a plugin route's text but are different paths. Before
    // the plugin fronted the whole API this over-capture was invisible.
    it.each([
      "/tunnelling",
      "/tunnels",
      "/tunnel-status",
      "/push-tokens-report",
      "/push-tokenize",
    ])("%s reaches OpenCode", (p) => {
      expect(route(p)).toBe("forward");
    });

    it("still matches the exact path and its children", () => {
      expect(route("/tunnel")).toBe("tunnel");
      expect(route("/tunnel/")).toBe("tunnel");
      expect(route("/tunnel/status")).toBe("tunnel");
      expect(route("/push-token")).toBe("push-token");
      expect(route("/push-token/register")).toBe("push-token");
    });

    it("does not answer a preflight for a merely similar path", () => {
      expect(route("/tunnelling", "OPTIONS")).toBe("forward");
    });
  });

  describe("CORS preflights", () => {
    it("are answered locally for the plugin's endpoints", () => {
      expect(route("/push-token", "OPTIONS")).toBe("cors-preflight");
      expect(route("/tunnel", "OPTIONS")).toBe("cors-preflight");
    });

    it("reach OpenCode for everything else, so its own CORS runs", () => {
      expect(route("/session", "OPTIONS")).toBe("forward");
      expect(route("/", "OPTIONS")).toBe("forward");
      expect(route("/event", "OPTIONS")).toBe("forward");
    });
  });

  describe("methods", () => {
    it.each(["GET", "POST", "DELETE", "PATCH", "PUT", "HEAD", undefined])(
      "%s on /session forwards",
      (method) => {
        expect(routeRequest({ pathname: "/session", method, overlayEnabled: true }).kind).toBe("forward");
      },
    );

    it("routes a POST to the plugin's tunnel endpoint locally", () => {
      expect(route("/tunnel", "POST")).toBe("tunnel");
    });
  });
});
