import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as http from "http";
import * as zlib from "zlib";
import type { AddressInfo } from "net";
import { forwardRequest, forwardUpgrade, buildRequestHeaders, wantsHtml, shouldRewrite } from "./forward";
import { OVERLAY_CSS_PATH, OVERLAY_JS_PATH } from "../overlay/config";
import type { OverlayConfig } from "../overlay/types";

const OVERLAY: OverlayConfig = { enabled: true, sessionStrip: true, maxWidth: 767 };

// The CSP OpenCode actually sends, including the theme-preload script hash.
const REAL_CSP =
  "default-src 'self'; script-src 'self' 'wasm-unsafe-eval' 'sha256-abc123'; " +
  "style-src 'self' 'unsafe-inline'; img-src 'self' data: https: blob:; " +
  "font-src 'self' data:; media-src 'self' data:; connect-src * data: blob:";

const HTML = [
  "<!doctype html>",
  '<html lang="en">',
  "  <head>",
  "    <title>OpenCode</title>",
  "  </head>",
  '  <body><div id="root"></div></body>',
  "</html>",
].join("\n");

interface Upstream {
  port: number;
  server: http.Server;
  requests: Array<{ url: string; method: string; headers: http.IncomingHttpHeaders; body: string }>;
}

async function listen(server: http.Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return (server.address() as AddressInfo).port;
}

async function close(server: http.Server | null): Promise<void> {
  if (!server) return;
  // An upgraded (or keep-alive) socket keeps `close` from ever calling back,
  // so drop connections first.
  const closeAll = (server as unknown as { closeAllConnections?: () => void }).closeAllConnections;
  if (typeof closeAll === "function") closeAll.call(server);
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

/** An upstream standing in for the OpenCode server. */
async function startUpstream(
  handler: (req: http.IncomingMessage, res: http.ServerResponse, body: string) => void,
): Promise<Upstream> {
  const requests: Upstream["requests"] = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      requests.push({ url: req.url || "", method: req.method || "", headers: req.headers, body });
      handler(req, res, body);
    });
  });
  const port = await listen(server);
  return { port, server, requests };
}

/** The plugin's proxy in front of that upstream. */
async function startProxy(targetPort: number, overlay: OverlayConfig | null): Promise<{ port: number; server: http.Server }> {
  const server = http.createServer((req, res) => {
    forwardRequest(req, res, {
      targetPort,
      overlay,
      cssPath: OVERLAY_CSS_PATH,
      jsPath: OVERLAY_JS_PATH,
    });
  });
  server.on("upgrade", (req, socket, head) => {
    forwardUpgrade(req, socket, head, {
      targetPort,
      overlay,
      cssPath: OVERLAY_CSS_PATH,
      jsPath: OVERLAY_JS_PATH,
    });
  });
  const port = await listen(server);
  return { port, server };
}

interface Fetched {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
}

function get(
  port: number,
  path: string,
  options: { headers?: Record<string, string>; method?: string; body?: string } = {},
): Promise<Fetched> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port, path, method: options.method || "GET", headers: options.headers },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () =>
          resolve({ status: res.statusCode || 0, headers: res.headers, body: Buffer.concat(chunks) }),
        );
      },
    );
    req.on("error", reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

let upstream: Upstream | null = null;
let proxy: { port: number; server: http.Server } | null = null;

beforeEach(() => {
  upstream = null;
  proxy = null;
});

afterEach(async () => {
  await close(proxy?.server ?? null);
  await close(upstream?.server ?? null);
});

async function harness(
  handler: (req: http.IncomingMessage, res: http.ServerResponse, body: string) => void,
  overlay: OverlayConfig | null = OVERLAY,
): Promise<void> {
  upstream = await startUpstream(handler);
  proxy = await startProxy(upstream.port, overlay);
}

function serveHtml(req: http.IncomingMessage, res: http.ServerResponse): void {
  res.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    "content-security-policy": REAL_CSP,
    "content-length": String(Buffer.byteLength(HTML)),
  });
  res.end(HTML);
}

describe("forward: pure helpers", () => {
  describe("wantsHtml", () => {
    it("is true for a browser navigation", () => {
      const req = { headers: { accept: "text/html,application/xhtml+xml,*/*;q=0.8" } } as http.IncomingMessage;
      expect(wantsHtml(req)).toBe(true);
    });

    it("is false for an API or event-stream request", () => {
      expect(wantsHtml({ headers: { accept: "application/json" } } as http.IncomingMessage)).toBe(false);
      expect(wantsHtml({ headers: { accept: "text/event-stream" } } as http.IncomingMessage)).toBe(false);
      expect(wantsHtml({ headers: {} } as http.IncomingMessage)).toBe(false);
    });
  });

  describe("buildRequestHeaders", () => {
    const req = {
      headers: { host: "tunnel.example.com", authorization: "Basic abc", "accept-encoding": "gzip, br" },
      socket: { remoteAddress: "10.0.0.9" },
    } as unknown as http.IncomingMessage;

    it("keeps Authorization so Basic auth survives the hop", () => {
      expect(buildRequestHeaders(req, false).authorization).toBe("Basic abc");
    });

    it("adds forwarding context", () => {
      const headers = buildRequestHeaders(req, false);
      expect(headers["x-forwarded-for"]).toBe("10.0.0.9");
      expect(headers["x-forwarded-host"]).toBe("tunnel.example.com");
    });

    it("strips accept-encoding only when asked", () => {
      expect(buildRequestHeaders(req, false)["accept-encoding"]).toBe("gzip, br");
      expect(buildRequestHeaders(req, true)["accept-encoding"]).toBeUndefined();
    });
  });

  describe("shouldRewrite", () => {
    const html = { "content-type": "text/html; charset=utf-8" };

    it("rewrites a 200 HTML response", () => {
      expect(shouldRewrite(OVERLAY, html, 200)).toBe(true);
    });

    it("never rewrites when the overlay is off", () => {
      expect(shouldRewrite(null, html, 200)).toBe(false);
      expect(shouldRewrite({ ...OVERLAY, enabled: false }, html, 200)).toBe(false);
    });

    it("leaves non-HTML alone", () => {
      expect(shouldRewrite(OVERLAY, { "content-type": "text/event-stream" }, 200)).toBe(false);
      expect(shouldRewrite(OVERLAY, { "content-type": "application/json" }, 200)).toBe(false);
      expect(shouldRewrite(OVERLAY, {}, 200)).toBe(false);
    });

    it("leaves redirects and errors alone", () => {
      expect(shouldRewrite(OVERLAY, html, 304)).toBe(false);
      expect(shouldRewrite(OVERLAY, html, 302)).toBe(false);
      expect(shouldRewrite(OVERLAY, html, 500)).toBe(false);
    });

    it("refuses to rewrite compressed HTML rather than corrupt it", () => {
      expect(shouldRewrite(OVERLAY, { ...html, "content-encoding": "gzip" }, 200)).toBe(false);
      expect(shouldRewrite(OVERLAY, { ...html, "content-encoding": "identity" }, 200)).toBe(true);
    });
  });
});

describe("forward: HTML rewriting", () => {
  it("injects the overlay into the document", async () => {
    await harness(serveHtml);
    const res = await get(proxy!.port, "/", { headers: { accept: "text/html" } });
    const body = res.body.toString();
    expect(res.status).toBe(200);
    expect(body).toContain(OVERLAY_CSS_PATH);
    expect(body).toContain(OVERLAY_JS_PATH);
    expect(body).toContain('<div id="root"></div>');
  });

  it("corrects content-length so the browser does not truncate", async () => {
    await harness(serveHtml);
    const res = await get(proxy!.port, "/", { headers: { accept: "text/html" } });
    expect(Number(res.headers["content-length"])).toBe(res.body.length);
    expect(res.body.length).toBeGreaterThan(Buffer.byteLength(HTML));
  });

  it("forwards the CSP verbatim", async () => {
    await harness(serveHtml);
    const res = await get(proxy!.port, "/", { headers: { accept: "text/html" } });
    expect(res.headers["content-security-policy"]).toBe(REAL_CSP);
  });

  it("strips accept-encoding upstream for navigations so the body is rewritable", async () => {
    await harness(serveHtml);
    await get(proxy!.port, "/", { headers: { accept: "text/html", "accept-encoding": "gzip" } });
    expect(upstream!.requests[0].headers["accept-encoding"]).toBeUndefined();
  });

  it("does not rewrite when the overlay is disabled", async () => {
    await harness(serveHtml, null);
    const res = await get(proxy!.port, "/", { headers: { accept: "text/html" } });
    expect(res.body.toString()).toBe(HTML);
    expect(res.body.toString()).not.toContain(OVERLAY_CSS_PATH);
  });

  it("passes gzipped HTML through untouched rather than corrupting it", async () => {
    const gzipped = zlib.gzipSync(Buffer.from(HTML));
    await harness((req, res) => {
      res.writeHead(200, { "content-type": "text/html", "content-encoding": "gzip" });
      res.end(gzipped);
    });
    const res = await get(proxy!.port, "/", { headers: { accept: "text/html" } });
    expect(zlib.gunzipSync(res.body).toString()).toBe(HTML);
  });

  it("does not inject twice if the upstream already carries the marker", async () => {
    await harness((req, res) => {
      const already =
        '<html><head><link rel="stylesheet" href="/x.css" data-oc-mobile-overlay></head><body></body></html>';
      res.writeHead(200, { "content-type": "text/html" });
      res.end(already);
    });
    const res = await get(proxy!.port, "/", { headers: { accept: "text/html" } });
    const occurrences = res.body.toString().split("data-oc-mobile-overlay").length - 1;
    expect(occurrences).toBe(1);
  });

  it("leaves an HTML error page alone", async () => {
    await harness((req, res) => {
      res.writeHead(500, { "content-type": "text/html" });
      res.end("<html><head></head><body>boom</body></html>");
    });
    const res = await get(proxy!.port, "/", { headers: { accept: "text/html" } });
    expect(res.status).toBe(500);
    expect(res.body.toString()).not.toContain(OVERLAY_CSS_PATH);
  });
});

describe("forward: pass-through", () => {
  it("returns JSON byte-identical", async () => {
    const payload = JSON.stringify([{ id: "ses_1", title: "Fix the tunnel" }]);
    await harness((req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(payload);
    });
    const res = await get(proxy!.port, "/session", { headers: { accept: "application/json" } });
    expect(res.body.toString()).toBe(payload);
  });

  it("keeps compression for non-document requests", async () => {
    await harness((req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
    });
    await get(proxy!.port, "/session", {
      headers: { accept: "application/json", "accept-encoding": "gzip" },
    });
    expect(upstream!.requests[0].headers["accept-encoding"]).toBe("gzip");
  });

  it("forwards the method, path, query and body", async () => {
    await harness((req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
    });
    await get(proxy!.port, "/session/ses_1/message?directory=%2Ftmp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: '{"text":"go"}',
    });
    const seen = upstream!.requests[0];
    expect(seen.method).toBe("POST");
    expect(seen.url).toBe("/session/ses_1/message?directory=%2Ftmp");
    expect(seen.body).toBe('{"text":"go"}');
  });

  it("forwards Authorization so OPENCODE_SERVER_PASSWORD keeps working", async () => {
    await harness((req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
    });
    await get(proxy!.port, "/session", { headers: { authorization: "Basic b3BlbmNvZGU6cHc=" } });
    expect(upstream!.requests[0].headers.authorization).toBe("Basic b3BlbmNvZGU6cHc=");
  });

  it("relays an upstream 401 challenge intact", async () => {
    await harness((req, res) => {
      res.writeHead(401, { "www-authenticate": 'Basic realm="opencode"' });
      res.end("Unauthorized");
    });
    const res = await get(proxy!.port, "/");
    expect(res.status).toBe(401);
    expect(res.headers["www-authenticate"]).toBe('Basic realm="opencode"');
  });

  it("answers 502 when OpenCode is not listening", async () => {
    // Point the proxy at a port nothing is bound to.
    const dead = http.createServer();
    const deadPort = await listen(dead);
    await close(dead);
    proxy = await startProxy(deadPort, OVERLAY);
    const res = await get(proxy.port, "/");
    expect(res.status).toBe(502);
  });
});

describe("forward: SSE", () => {
  it("streams events as they happen instead of buffering the response", async () => {
    let push: ((chunk: string) => void) | null = null;
    let finish: (() => void) | null = null;

    upstream = await startUpstream((req, res) => {
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      push = (chunk: string) => res.write(chunk);
      finish = () => res.end();
    });
    proxy = await startProxy(upstream.port, OVERLAY);

    const received: string[] = [];
    const done = new Promise<void>((resolve, reject) => {
      const req = http.request(
        { host: "127.0.0.1", port: proxy!.port, path: "/event", headers: { accept: "text/event-stream" } },
        (res) => {
          expect(res.headers["content-type"]).toContain("text/event-stream");
          res.on("data", (chunk: Buffer) => received.push(chunk.toString()));
          res.on("end", () => resolve());
        },
      );
      req.on("error", reject);
      req.end();
    });

    // Wait for the upstream handler to run.
    await new Promise((resolve) => setTimeout(resolve, 60));
    push!('data: {"type":"session.status"}\n\n');

    // The first event must arrive before the stream closes. If the proxy were
    // buffering, `received` would still be empty here.
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(received.join("")).toContain("session.status");

    push!('data: {"type":"session.idle"}\n\n');
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(received.join("")).toContain("session.idle");

    finish!();
    await done;
  });
});

describe("forward: upgrades", () => {
  it("proxies a protocol upgrade end to end", async () => {
    // Upgraded sockets are detached from the server, so `closeAllConnections`
    // does not reach them; track them here and tear them down explicitly.
    const sockets: Array<{ destroy: () => void }> = [];

    const server = http.createServer();
    server.on("upgrade", (req, socket) => {
      sockets.push(socket);
      socket.write(
        "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n",
      );
      socket.on("error", () => socket.destroy());
      socket.on("data", (chunk: Buffer) => socket.write(Buffer.from("echo:" + chunk.toString())));
    });
    const upstreamPort = await listen(server);
    upstream = { port: upstreamPort, server, requests: [] };
    proxy = await startProxy(upstreamPort, OVERLAY);

    try {
      const result = await new Promise<string>((resolve, reject) => {
        const req = http.request({
          host: "127.0.0.1",
          port: proxy!.port,
          path: "/socket",
          headers: { connection: "Upgrade", upgrade: "websocket" },
        });
        req.on("upgrade", (res, socket) => {
          sockets.push(socket);
          socket.on("error", () => socket.destroy());
          expect(res.statusCode).toBe(101);
          socket.write("ping");
          socket.once("data", (chunk: Buffer) => resolve(chunk.toString()));
        });
        req.on("error", reject);
        req.end();
      });

      expect(result).toBe("echo:ping");
    } finally {
      for (const socket of sockets) socket.destroy();
    }
  });
});
