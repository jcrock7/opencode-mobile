/**
 * Exercises the fully assembled plugin server -- the same composition index.ts
 * builds -- against a stand-in OpenCode. Unit tests cover the pieces; this
 * covers the wiring between them.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as http from "http";
import type { AddressInfo } from "net";
import { routeRequest } from "./route";
import { forwardRequest, forwardUpgrade, type ForwardOptions } from "./forward";
import {
  handleOverlayAsset,
  loadOverlayConfig,
  pathnameOf,
  OVERLAY_CSS_PATH,
  OVERLAY_JS_PATH,
} from "../overlay";

const HTML =
  '<!doctype html>\n<html><head><title>OpenCode</title></head><body><div id="root"></div></body></html>';

const CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

let opencode: http.Server | null = null;
let plugin: http.Server | null = null;
let pluginPort = 0;
let seen: string[] = [];
let pluginHandled: string[] = [];

async function listen(server: http.Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return (server.address() as AddressInfo).port;
}

async function close(server: http.Server | null): Promise<void> {
  if (!server) return;
  const closeAll = (server as unknown as { closeAllConnections?: () => void }).closeAllConnections;
  if (typeof closeAll === "function") closeAll.call(server);
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

/** Stand-in for `opencode serve`: HTML at /, JSON API, SSE at /event. */
function makeOpenCode(): http.Server {
  return http.createServer((req, res) => {
    const url = req.url || "";
    seen.push(url);

    if (url === "/") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "content-security-policy": CSP });
      res.end(HTML);
      return;
    }
    if (url === "/session") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify([{ id: "ses_1", title: "Fix tunnel" }]));
      return;
    }
    if (url === "/session/status") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ses_1: { type: "busy" } }));
      return;
    }
    if (url === "/event") {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write('data: {"type":"session.status"}\n\n');
      res.end();
      return;
    }
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("nope");
  });
}

/**
 * The plugin server, composed exactly as index.ts composes it.
 */
function makePlugin(openCodePort: number): http.Server {
  const overlay = loadOverlayConfig({});
  const forwardOptions: ForwardOptions = {
    targetPort: openCodePort,
    overlay: overlay.enabled ? overlay : null,
    cssPath: OVERLAY_CSS_PATH,
    jsPath: overlay.sessionStrip ? OVERLAY_JS_PATH : undefined,
  };

  const server = http.createServer((req, res) => {
    const pathname = pathnameOf(req.url || "");
    const route = routeRequest({ pathname, method: req.method, overlayEnabled: overlay.enabled });

    switch (route.kind) {
      case "cors-preflight":
        pluginHandled.push("cors:" + pathname);
        res.writeHead(204, cors);
        res.end();
        return;
      case "push-token":
        pluginHandled.push("push-token:" + pathname);
        res.writeHead(200, { "content-type": "application/json" });
        res.end("[]");
        return;
      case "tunnel":
        pluginHandled.push("tunnel:" + pathname);
        res.writeHead(200, { "content-type": "application/json" });
        res.end("{}");
        return;
      case "overlay-asset":
        pluginHandled.push("overlay:" + pathname);
        if (handleOverlayAsset(pathname, req, res, overlay)) return;
        break;
      case "forward":
        break;
    }

    forwardRequest(req, res, forwardOptions);
  });

  server.on("upgrade", (req, socket, head) => {
    forwardUpgrade(req, socket, head, forwardOptions);
  });

  return server;
}

function get(
  path: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port: pluginPort, path, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () =>
        resolve({
          status: res.statusCode || 0,
          headers: res.headers,
          body: Buffer.concat(chunks).toString(),
        }),
      );
    });
    req.on("error", reject);
    req.end();
  });
}

beforeEach(async () => {
  seen = [];
  pluginHandled = [];
  opencode = makeOpenCode();
  const openCodePort = await listen(opencode);
  plugin = makePlugin(openCodePort);
  pluginPort = await listen(plugin);
});

afterEach(async () => {
  await close(plugin);
  await close(opencode);
  plugin = null;
  opencode = null;
});

describe("assembled plugin server", () => {
  it("serves OpenCode's UI with the overlay injected", async () => {
    const res = await get("/", { accept: "text/html" });
    expect(res.status).toBe(200);
    expect(res.body).toContain('<div id="root"></div>');
    expect(res.body).toContain(OVERLAY_CSS_PATH);
    expect(res.body).toContain(OVERLAY_JS_PATH);
    expect(res.headers["content-security-policy"]).toBe(CSP);
    expect(Number(res.headers["content-length"])).toBe(Buffer.byteLength(res.body));
  });

  it("serves the overlay stylesheet itself, without asking OpenCode", async () => {
    const res = await get(OVERLAY_CSS_PATH);
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toBe("text/css; charset=utf-8");
    expect(pluginHandled).toContain("overlay:" + OVERLAY_CSS_PATH);
    expect(seen).not.toContain(OVERLAY_CSS_PATH);
  });

  it("serves the overlay script from the same origin as the page", async () => {
    const res = await get(OVERLAY_JS_PATH);
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toBe("text/javascript; charset=utf-8");
    expect(() => new Function(res.body)).not.toThrow();
  });

  it("passes the session list through untouched", async () => {
    const res = await get("/session", { accept: "application/json" });
    expect(JSON.parse(res.body)).toEqual([{ id: "ses_1", title: "Fix tunnel" }]);
    expect(seen).toContain("/session");
  });

  it("passes the status map the strip reads", async () => {
    const res = await get("/session/status", { accept: "application/json" });
    expect(JSON.parse(res.body)).toEqual({ ses_1: { type: "busy" } });
  });

  it("passes the event stream through as an event stream", async () => {
    const res = await get("/event", { accept: "text/event-stream" });
    expect(res.headers["content-type"]).toContain("text/event-stream");
    expect(res.body).toContain("session.status");
  });

  it("keeps answering its own push-token endpoint", async () => {
    const res = await get("/push-token");
    expect(res.status).toBe(200);
    expect(pluginHandled).toContain("push-token:/push-token");
    expect(seen).not.toContain("/push-token");
  });

  it("keeps answering its own tunnel endpoint", async () => {
    await get("/tunnel");
    expect(pluginHandled).toContain("tunnel:/tunnel");
    expect(seen).not.toContain("/tunnel");
  });

  it("relays an OpenCode 404 rather than inventing one", async () => {
    const res = await get("/nope");
    expect(res.status).toBe(404);
    expect(res.body).toBe("nope");
    expect(seen).toContain("/nope");
  });

  it("preserves the query string through the hop", async () => {
    await get("/session?directory=%2Ftmp%2Fproj");
    expect(seen).toContain("/session?directory=%2Ftmp%2Fproj");
  });

  it("does not double-inject on a second load", async () => {
    const first = await get("/", { accept: "text/html" });
    const second = await get("/", { accept: "text/html" });
    expect(second.body).toBe(first.body);
    expect(second.body.split("data-oc-mobile-overlay").length - 1).toBe(2);
  });
});
