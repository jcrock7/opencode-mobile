/**
 * forward-edges.test.ts - the proxy's failure and boundary paths.
 *
 * Complements forward.test.ts (the happy paths and header contracts) with the
 * cases that only show up when something goes wrong: an oversized document, an
 * upstream that dies mid-body, a client that hangs up, and upgrades carrying
 * repeated headers or a pre-read head buffer.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as http from "http";
import type { AddressInfo } from "net";
import {
  forwardRequest,
  forwardUpgrade,
  buildRequestHeaders,
  buildResponseHeaders,
  upgradeRequestHeaders,
  hopByHopFor,
  wantsHtml,
  namesDirectory,
  MAX_HTML_BYTES,
  DEFAULT_TARGET_HOST,
  type ForwardOptions,
} from "./forward";
import { OVERLAY_CSS_PATH, OVERLAY_JS_PATH } from "../overlay/config";
import type { OverlayConfig } from "../overlay/types";

const OVERLAY: OverlayConfig = { enabled: true, sessionStrip: true, statusBar: true, keyboardViewport: true, bubbles: true, changesButton: true, askDock: true, askGraceMs: 2500, maxWidth: 767, debug: false };

let upstream: http.Server | null = null;
let proxy: http.Server | null = null;
let proxyPort = 0;

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

async function harness(
  handler: http.RequestListener,
  overrides: Partial<ForwardOptions> = {},
): Promise<void> {
  upstream = http.createServer(handler);
  const upstreamPort = await listen(upstream);

  const options: ForwardOptions = {
    targetPort: upstreamPort,
    overlay: OVERLAY,
    cssPath: OVERLAY_CSS_PATH,
    jsPath: OVERLAY_JS_PATH,
    ...overrides,
  };

  proxy = http.createServer((req, res) => forwardRequest(req, res, options));
  proxy.on("upgrade", (req, socket, head) => forwardUpgrade(req, socket, head, options));
  proxyPort = await listen(proxy);
}

function get(
  path: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port: proxyPort, path, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () =>
        resolve({ status: res.statusCode || 0, headers: res.headers, body: Buffer.concat(chunks) }),
      );
      res.on("error", reject);
    });
    req.on("error", reject);
    req.end();
  });
}

beforeEach(() => {
  upstream = null;
  proxy = null;
});

afterEach(async () => {
  await close(proxy);
  await close(upstream);
});


function req(headers: http.IncomingHttpHeaders): http.IncomingMessage {
  return { headers, url: "/", method: "GET", socket: {} } as unknown as http.IncomingMessage;
}

describe("hop-by-hop headers", () => {
  // RFC 7230 6.1. Copying these verbatim is harmless on loopback -- there is no
  // intermediary to confuse, and a local latency measurement shows no cost
  // either way -- but through Cloudflare there is one, and handing it a
  // `connection` or `transfer-encoding` describing OUR link to OpenCode rather
  // than its link to us is how a proxy chain re-frames bodies, drops keep-alive
  // it should have kept, or buffers a stream meant to arrive event by event.

  it.each([
    "connection",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
  ])("drops %s from a forwarded request", (name) => {
    const headers = buildRequestHeaders(req({ [name]: "something", accept: "application/json" }), false);
    expect(headers[name]).toBeUndefined();
    expect(headers.accept).toBe("application/json");
  });

  it("drops them from the response too", () => {
    const headers = buildResponseHeaders({
      "transfer-encoding": "chunked",
      connection: "keep-alive",
      "content-type": "text/event-stream",
      "content-length": "12",
    });
    expect(headers["transfer-encoding"]).toBeUndefined();
    expect(headers.connection).toBeUndefined();
    expect(headers["content-type"]).toBe("text/event-stream");
    // End to end, not hop by hop: dropping it would break every ranged fetch.
    expect(headers["content-length"]).toBe("12");
  });

  it("honours extra names the sender listed in Connection", () => {
    // A sender may extend the set, and a proxy that ignores that relays a
    // header it was explicitly asked not to.
    const headers = buildRequestHeaders(
      req({ connection: "keep-alive, X-Private", "x-private": "secret", accept: "*/*" }),
      false,
    );
    expect(headers["x-private"]).toBeUndefined();
    expect(headers.accept).toBe("*/*");
  });

  it("exposes the set it computed, so a caller can reason about it", () => {
    expect(hopByHopFor({}).has("transfer-encoding")).toBe(true);
    expect(hopByHopFor({}).has("content-length")).toBe(false);
    expect(hopByHopFor({ connection: "X-Thing" }).has("x-thing")).toBe(true);
  });

  it("does not read close or keep-alive as header names", () => {
    const headers = buildResponseHeaders({ connection: "close", "content-type": "application/json" });
    expect(headers["content-type"]).toBe("application/json");
  });

  it("keeps the handshake headers on an upgrade, which needs them", () => {
    // Connection: Upgrade IS the request there; stripping it the way an
    // ordinary forward does turns a handshake into a plain GET.
    const headers = upgradeRequestHeaders(
      req({
        connection: "Upgrade",
        upgrade: "websocket",
        "sec-websocket-key": "abc",
        "sec-websocket-version": "13",
      }),
    );
    expect(headers.connection).toBe("Upgrade");
    expect(headers.upgrade).toBe("websocket");
    expect(headers["sec-websocket-key"]).toBe("abc");
    expect(headers["sec-websocket-version"]).toBe("13");
  });

  it("still applies the directory default on an upgrade", () => {
    const headers = upgradeRequestHeaders(req({ upgrade: "websocket" }), "/home/jared/repo");
    expect(headers["x-opencode-directory"]).toBe("/home/jared/repo");
  });
});

describe("constants and header helpers", () => {
  it("defaults the target to loopback", () => {
    expect(DEFAULT_TARGET_HOST).toBe("127.0.0.1");
  });

  it("caps the HTML buffer at 8 MiB", () => {
    expect(MAX_HTML_BYTES).toBe(8 * 1024 * 1024);
  });

  it("skips an undefined request header", () => {
    const req = {
      headers: { host: "x", "x-gone": undefined },
      socket: {},
    } as unknown as http.IncomingMessage;

    const headers = buildRequestHeaders(req, false);
    expect("x-gone" in headers).toBe(false);
    expect(headers.host).toBe("x");
  });

  it("omits forwarding context when the socket has no address", () => {
    const req = { headers: {}, socket: {} } as unknown as http.IncomingMessage;
    const headers = buildRequestHeaders(req, false);
    expect("x-forwarded-for" in headers).toBe(false);
    expect("x-forwarded-host" in headers).toBe(false);
  });

  it("tolerates a missing socket", () => {
    const req = { headers: { host: "x" } } as unknown as http.IncomingMessage;
    expect(() => buildRequestHeaders(req, false)).not.toThrow();
  });

  it("preserves a repeated response header", () => {
    const headers = buildResponseHeaders({
      "set-cookie": ["a=1", "b=2"],
      "content-type": "text/html",
      "x-gone": undefined,
    });
    expect(headers["set-cookie"]).toEqual(["a=1", "b=2"]);
    expect("x-gone" in headers).toBe(false);
  });

  it("treats a repeated accept header as non-HTML", () => {
    // Node only produces an array for a few headers, but the guard must hold.
    const req = { headers: { accept: ["text/html"] } } as unknown as http.IncomingMessage;
    expect(wantsHtml(req)).toBe(false);
  });
});

describe("the instance directory", () => {
  // OpenCode resolves an instance per request from `?directory=` or
  // `x-opencode-directory`. A request with neither lands on an instance that
  // knows about nothing: the overlay's own `GET /session` answered 200 with an
  // empty array and its event stream carried only heartbeats. The overlay
  // cannot fix that itself -- EventSource cannot set headers, and the v2 route
  // encodes a server key rather than a directory -- so the proxy supplies it.

  it("recognises a directory in the query string", () => {
    const req = { headers: {}, url: "/session?directory=%2Fhome%2Fdev%2Fmiser" } as http.IncomingMessage;
    expect(namesDirectory(req)).toBe(true);
  });

  it("recognises a directory in the header", () => {
    const req = {
      headers: { "x-opencode-directory": "/home/dev/miser" },
      url: "/session",
    } as unknown as http.IncomingMessage;
    expect(namesDirectory(req)).toBe(true);
  });

  it("reports a request that names none", () => {
    expect(namesDirectory({ headers: {}, url: "/session" } as http.IncomingMessage)).toBe(false);
    expect(namesDirectory({ headers: {}, url: "/session?limit=5" } as http.IncomingMessage)).toBe(false);
    expect(namesDirectory({ headers: {}, url: "" } as http.IncomingMessage)).toBe(false);
  });

  it("does not mistake another parameter for a directory", () => {
    const req = { headers: {}, url: "/session?directoryish=1" } as http.IncomingMessage;
    expect(namesDirectory(req)).toBe(false);
  });

  it("adds the default when the request names none", () => {
    const req = { headers: { host: "x" }, url: "/session", socket: {} } as unknown as http.IncomingMessage;
    const headers = buildRequestHeaders(req, false, "/home/dev/miser");
    expect(headers["x-opencode-directory"]).toBe("/home/dev/miser");
  });

  it("never overrides a directory the caller chose", () => {
    // A default, not an override: the app always sends its own, and hijacking
    // it would point the whole UI at the wrong project.
    const req = {
      headers: { "x-opencode-directory": "/home/dev/other" },
      url: "/session",
      socket: {},
    } as unknown as http.IncomingMessage;
    const headers = buildRequestHeaders(req, false, "/home/dev/miser");
    expect(headers["x-opencode-directory"]).toBe("/home/dev/other");
  });

  it("leaves a query-string directory alone", () => {
    const req = {
      headers: {},
      url: "/session?directory=%2Fhome%2Fdev%2Fother",
      socket: {},
    } as unknown as http.IncomingMessage;
    const headers = buildRequestHeaders(req, false, "/home/dev/miser");
    expect(headers["x-opencode-directory"]).toBeUndefined();
  });

  it("adds nothing when no default is configured", () => {
    const req = { headers: {}, url: "/session", socket: {} } as unknown as http.IncomingMessage;
    const headers = buildRequestHeaders(req, false);
    expect("x-opencode-directory" in headers).toBe(false);
  });

  it("reaches OpenCode on a real forwarded request", async () => {
    let seen: string | undefined;
    await harness(
      (req, res) => {
        seen = req.headers["x-opencode-directory"] as string | undefined;
        res.writeHead(200, { "content-type": "application/json" });
        res.end("[]");
      },
      { defaultDirectory: "/home/dev/miser" },
    );

    await get("/session");
    expect(seen).toBe("/home/dev/miser");
  });

  it("reaches OpenCode on an upgrade too", async () => {
    // The event stream is the case that matters most and the one the overlay
    // could never fix for itself.
    let seen: string | undefined;
    const server = http.createServer();
    const sockets: Array<{ destroy: () => void }> = [];
    server.on("upgrade", (req, socket) => {
      seen = req.headers["x-opencode-directory"] as string | undefined;
      sockets.push(socket);
      socket.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n");
      socket.on("error", () => socket.destroy());
    });
    const upstreamPort = await listen(server);
    upstream = server;

    const options: ForwardOptions = {
      targetPort: upstreamPort,
      overlay: OVERLAY,
      cssPath: OVERLAY_CSS_PATH,
      jsPath: OVERLAY_JS_PATH,
      defaultDirectory: "/home/dev/miser",
    };
    proxy = http.createServer();
    proxy.on("upgrade", (req, socket, head) => forwardUpgrade(req, socket, head, options));
    proxyPort = await listen(proxy);

    try {
      await new Promise<void>((resolve, reject) => {
        const req = http.request({
          host: "127.0.0.1",
          port: proxyPort,
          path: "/event",
          headers: { connection: "Upgrade", upgrade: "websocket" },
        });
        req.on("upgrade", (_res, socket) => {
          sockets.push(socket);
          socket.on("error", () => socket.destroy());
          resolve();
        });
        req.on("error", reject);
        req.end();
      });
      expect(seen).toBe("/home/dev/miser");
    } finally {
      for (const s of sockets) s.destroy();
    }
  });
});

describe("oversized documents", () => {
  it("streams past the ceiling instead of buffering, leaving the body intact", async () => {
    const body = "<html><head></head><body>" + "x".repeat(4096) + "</body></html>";
    await harness(
      (req, res) => {
        res.writeHead(200, { "content-type": "text/html" });
        // Two writes so the ceiling trips on the second, exercising the
        // replay-what-was-buffered path.
        res.write(body.slice(0, 200));
        res.write(body.slice(200));
        res.end();
      },
      { maxHtmlBytes: 256 },
    );

    const res = await get("/", { accept: "text/html" });
    expect(res.status).toBe(200);
    expect(res.body.toString()).toBe(body);
    // Too big to rewrite, so it must arrive unmodified rather than truncated.
    expect(res.body.toString()).not.toContain(OVERLAY_CSS_PATH);
  });

  it("still rewrites a document under the ceiling", async () => {
    await harness(
      (req, res) => {
        res.writeHead(200, { "content-type": "text/html" });
        res.end("<html><head></head><body>small</body></html>");
      },
      { maxHtmlBytes: 4096 },
    );

    const res = await get("/", { accept: "text/html" });
    expect(res.body.toString()).toContain(OVERLAY_CSS_PATH);
  });
});

describe("upstream failures", () => {
  it("does not hang when the upstream aborts mid-body", async () => {
    await harness((req, res) => {
      res.writeHead(200, { "content-type": "text/html", "content-length": "1000" });
      res.write("<html><head>");
      // Destroy the socket without finishing the declared body.
      res.socket?.destroy();
    });

    // Either an error or a short body is acceptable; hanging is not.
    await expect(
      Promise.race([
        get("/", { accept: "text/html" }).catch(() => "errored"),
        new Promise((_, reject) => setTimeout(() => reject(new Error("hung")), 3000)),
      ]),
    ).resolves.toBeDefined();
  });

  it("returns 502 when the upstream refuses the connection", async () => {
    const dead = http.createServer();
    const deadPort = await listen(dead);
    await close(dead);

    const options: ForwardOptions = {
      targetPort: deadPort,
      overlay: OVERLAY,
      cssPath: OVERLAY_CSS_PATH,
      jsPath: OVERLAY_JS_PATH,
    };
    proxy = http.createServer((req, res) => forwardRequest(req, res, options));
    proxyPort = await listen(proxy);

    const res = await get("/");
    expect(res.status).toBe(502);
    expect(res.body.toString()).toBe("Bad Gateway");
  });

  it("stops talking upstream when the client hangs up", async () => {
    let aborted = false;
    await harness((req, res) => {
      req.on("aborted", () => { aborted = true; });
      res.writeHead(200, { "content-type": "application/json" });
      // Never finish: the client will disconnect first.
      res.write("{");
    });

    await new Promise<void>((resolve) => {
      const req = http.request({ host: "127.0.0.1", port: proxyPort, path: "/slow" }, (res) => {
        res.on("data", () => req.destroy());
        res.on("close", () => resolve());
      });
      req.on("error", () => resolve());
      req.end();
    });

    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(aborted).toBe(true);
  });
});

describe("upgrades", () => {
  it("relays repeated headers on the 101 response", async () => {
    const server = http.createServer();
    const sockets: Array<{ destroy: () => void }> = [];
    server.on("upgrade", (req, socket) => {
      sockets.push(socket);
      socket.write(
        "HTTP/1.1 101 Switching Protocols\r\n" +
          "Upgrade: websocket\r\n" +
          "Connection: Upgrade\r\n" +
          "Set-Cookie: a=1\r\n" +
          "Set-Cookie: b=2\r\n\r\n",
      );
      socket.on("error", () => socket.destroy());
    });
    const upstreamPort = await listen(server);
    upstream = server;

    const options: ForwardOptions = {
      targetPort: upstreamPort,
      overlay: OVERLAY,
      cssPath: OVERLAY_CSS_PATH,
      jsPath: OVERLAY_JS_PATH,
    };
    proxy = http.createServer();
    proxy.on("upgrade", (req, socket, head) => forwardUpgrade(req, socket, head, options));
    proxyPort = await listen(proxy);

    try {
      const cookies = await new Promise<string[]>((resolve, reject) => {
        const req = http.request({
          host: "127.0.0.1",
          port: proxyPort,
          path: "/ws",
          headers: { connection: "Upgrade", upgrade: "websocket" },
        });
        req.on("upgrade", (res, socket) => {
          sockets.push(socket);
          socket.on("error", () => socket.destroy());
          const raw = res.headers["set-cookie"];
          resolve(Array.isArray(raw) ? raw : [String(raw)]);
        });
        req.on("error", reject);
        req.end();
      });

      expect(cookies).toContain("a=1");
      expect(cookies).toContain("b=2");
    } finally {
      for (const s of sockets) s.destroy();
    }
  });

  it("destroys the client socket when the upstream is unreachable", async () => {
    const dead = http.createServer();
    const deadPort = await listen(dead);
    await close(dead);

    const options: ForwardOptions = {
      targetPort: deadPort,
      overlay: OVERLAY,
      cssPath: OVERLAY_CSS_PATH,
      jsPath: OVERLAY_JS_PATH,
    };
    proxy = http.createServer();
    proxy.on("upgrade", (req, socket, head) => forwardUpgrade(req, socket, head, options));
    proxyPort = await listen(proxy);

    const closed = await new Promise<boolean>((resolve) => {
      const req = http.request({
        host: "127.0.0.1",
        port: proxyPort,
        path: "/ws",
        headers: { connection: "Upgrade", upgrade: "websocket" },
      });
      req.on("error", () => resolve(true));
      req.on("close", () => resolve(true));
      req.end();
      setTimeout(() => resolve(false), 2000);
    });

    expect(closed).toBe(true);
  });
});
