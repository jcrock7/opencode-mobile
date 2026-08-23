/**
 * Streaming reverse proxy to the OpenCode server.
 *
 * Design constraints, in order of importance:
 *
 * 1. Only `text/html` is ever buffered. Everything else -- most importantly the
 *    `/event` SSE stream and file downloads -- is piped through untouched, so
 *    the app keeps receiving events as they happen.
 * 2. `content-security-policy` is forwarded verbatim. OpenCode computes it from
 *    a hash of its own theme-preload script; recomputing or dropping it would
 *    either break the page or weaken it. The policy already permits the overlay
 *    (`style-src 'unsafe-inline'`, `script-src 'self'`).
 * 3. `Authorization` passes straight through, so HTTP Basic auth
 *    (OPENCODE_SERVER_PASSWORD) keeps working end to end.
 * 4. WebSocket upgrades are proxied, not dropped.
 */

import * as http from "http";
import type { Duplex } from "stream";
import { injectOverlay, isHtmlContentType } from "../overlay/inject";
import type { OverlayConfig } from "../overlay/types";

export const DEFAULT_TARGET_HOST = "127.0.0.1";

/** Refuse to buffer an implausibly large "document" (8 MiB). */
export const MAX_HTML_BYTES = 8 * 1024 * 1024;

export interface ForwardOptions {
  targetPort: number;
  targetHost?: string;
  /** null disables HTML rewriting entirely; bytes are then always streamed. */
  overlay: OverlayConfig | null;
  cssPath: string;
  jsPath?: string;
  /** Buffer ceiling for HTML rewriting. Defaults to MAX_HTML_BYTES. */
  maxHtmlBytes?: number;
  /**
   * Instance directory to fall back to when a request names none.
   *
   * OpenCode's server is instance-per-request: it resolves which project a call
   * belongs to from `?directory=` or `x-opencode-directory`, and a request with
   * neither lands on an instance that knows about nothing. Its own web app
   * always sends one, so this never mattered until the overlay started making
   * calls of its own -- `GET /session` answered 200 with an empty array, and
   * the event stream delivered heartbeats and nothing else.
   *
   * The overlay cannot fix this for itself: `EventSource` cannot set headers,
   * and the v2 route encodes a server key rather than a directory, so there is
   * nothing to read the project out of. The proxy can, because the plugin knows
   * which instance it was loaded for.
   *
   * Applied ONLY when the request names no directory, so it is a default and
   * never an override.
   */
  defaultDirectory?: string;
}

type OutgoingHeaders = Record<string, string | string[]>;

/**
 * Headers that belong to one hop and must not be relayed to the next.
 *
 * RFC 7230 6.1. This code copied every header verbatim in both directions,
 * which on loopback is harmless -- there is no intermediary to confuse, and a
 * local latency measurement shows no cost either way. Through Cloudflare there
 * is one, and handing it a `connection` or `transfer-encoding` header that
 * describes *our* link to OpenCode rather than its link to us is how a proxy
 * chain ends up re-framing bodies, dropping keep-alive it should have kept, or
 * buffering a stream that was meant to arrive event by event.
 *
 * `content-length` is deliberately absent: that one is end to end.
 */
const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

/**
 * Hop-by-hop headers for one message: the standard set, plus whatever this
 * message's own `Connection` header names. A sender may extend the list, and a
 * proxy that ignores that leaks a header the sender asked it not to relay.
 */
export function hopByHopFor(headers: http.IncomingHttpHeaders): Set<string> {
  const named = new Set(HOP_BY_HOP);
  const connection = headers["connection"];
  const raw = Array.isArray(connection) ? connection.join(",") : connection;
  if (typeof raw === "string") {
    for (const token of raw.split(",")) {
      const name = token.trim().toLowerCase();
      // "close" and "keep-alive" are directives about the connection itself,
      // not the names of other headers.
      if (name && name !== "close" && name !== "keep-alive") named.add(name);
    }
  }
  return named;
}

function copyEndToEnd(source: http.IncomingHttpHeaders): OutgoingHeaders {
  const drop = hopByHopFor(source);
  const headers: OutgoingHeaders = {};
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) continue;
    if (drop.has(key.toLowerCase())) continue;
    headers[key] = value;
  }
  return headers;
}

/**
 * Copy request headers, dropping nothing but adding forwarding context.
 *
 * `accept-encoding` is stripped for document requests only: we may need to
 * rewrite the body, and we cannot rewrite compressed bytes. Assets and event
 * streams keep their compression.
 */
/** True when the request already says which instance it means. */
export function namesDirectory(req: http.IncomingMessage): boolean {
  if (req.headers["x-opencode-directory"] !== undefined) return true;
  const url = req.url ?? "";
  const query = url.slice(url.indexOf("?") + 1);
  if (url.indexOf("?") === -1) return false;
  return new URLSearchParams(query).has("directory");
}

export function buildRequestHeaders(
  req: http.IncomingMessage,
  stripEncoding: boolean,
  defaultDirectory?: string,
): OutgoingHeaders {
  const headers = copyEndToEnd(req.headers);

  if (stripEncoding) delete headers["accept-encoding"];

  // Only when the caller named none: a default, never an override.
  if (defaultDirectory && !namesDirectory(req)) {
    headers["x-opencode-directory"] = defaultDirectory;
  }

  const remote = req.socket?.remoteAddress;
  if (remote) headers["x-forwarded-for"] = remote;
  const host = req.headers.host;
  if (host) headers["x-forwarded-host"] = host;

  return headers;
}

/** A navigation request -- the only kind whose body we might rewrite. */
export function wantsHtml(req: http.IncomingMessage): boolean {
  const accept = req.headers.accept;
  if (typeof accept !== "string") return false;
  return accept.toLowerCase().includes("text/html");
}

export function buildResponseHeaders(source: http.IncomingHttpHeaders): OutgoingHeaders {
  return copyEndToEnd(source);
}

/**
 * Decide whether this response body should be rewritten.
 *
 * Compressed HTML is passed through rather than corrupted -- stripping
 * `accept-encoding` above should prevent it, but an upstream is free to ignore
 * that and we must not produce garbage if it does.
 */
export function shouldRewrite(
  overlay: OverlayConfig | null,
  headers: http.IncomingHttpHeaders,
  statusCode: number | undefined,
): boolean {
  if (!overlay || !overlay.enabled) return false;
  if (statusCode !== undefined && (statusCode < 200 || statusCode >= 300)) return false;
  if (!isHtmlContentType(typeof headers["content-type"] === "string" ? headers["content-type"] : undefined)) {
    return false;
  }
  const encoding = headers["content-encoding"];
  if (typeof encoding === "string" && encoding.trim() !== "" && encoding.trim().toLowerCase() !== "identity") {
    return false;
  }
  return true;
}

function failGateway(res: http.ServerResponse, message: string): void {
  if (res.headersSent) {
    res.end();
    return;
  }
  res.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
  res.end(message);
}

export function forwardRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  options: ForwardOptions,
): void {
  const proxyReq = http.request(
    {
      host: options.targetHost ?? DEFAULT_TARGET_HOST,
      port: options.targetPort,
      path: req.url || "/",
      method: req.method,
      headers: buildRequestHeaders(req, wantsHtml(req), options.defaultDirectory),
    },
    (proxyRes) => {
      const headers = buildResponseHeaders(proxyRes.headers);
      const status = proxyRes.statusCode ?? 200;

      if (!shouldRewrite(options.overlay, proxyRes.headers, proxyRes.statusCode)) {
        res.writeHead(status, headers);
        proxyRes.pipe(res);
        return;
      }

      // HTML: buffer, inject, re-length.
      const ceiling = options.maxHtmlBytes ?? MAX_HTML_BYTES;
      const chunks: Buffer[] = [];
      let size = 0;
      let overflowed = false;

      proxyRes.on("data", (chunk: Buffer) => {
        if (overflowed) return;
        size += chunk.length;
        if (size > ceiling) {
          // Bail out of rewriting and stream what is left rather than holding
          // an unbounded buffer.
          overflowed = true;
          res.writeHead(status, headers);
          for (const buffered of chunks) res.write(buffered);
          chunks.length = 0;
          res.write(chunk);
          proxyRes.pipe(res);
          return;
        }
        chunks.push(chunk);
      });

      proxyRes.on("end", () => {
        if (overflowed) return;
        const original = Buffer.concat(chunks).toString("utf-8");
        const rewritten = injectOverlay(original, {
          cssPath: options.cssPath,
          jsPath: options.jsPath,
        });

        // The byte count changed; a stale content-length would truncate the
        // document in the browser.
        delete headers["content-length"];
        delete headers["transfer-encoding"];
        headers["content-length"] = String(Buffer.byteLength(rewritten));

        res.writeHead(status, headers);
        res.end(rewritten);
      });

      proxyRes.on("error", () => failGateway(res, "Upstream error"));
    },
  );

  proxyReq.on("error", (error: Error) => {
    console.error("[Proxy] Forward failed:", error.message);
    failGateway(res, "Bad Gateway");
  });

  // If the phone hangs up mid-request, stop talking to OpenCode.
  res.on("close", () => {
    proxyReq.destroy();
  });

  req.pipe(proxyReq);
}

/**
 * Proxy a WebSocket (or other protocol) upgrade.
 *
 * Without this the app's socket-backed features would simply fail against the
 * proxy, because an upgrade is not an ordinary request/response pair.
 */
/**
 * Headers for an upgrade, which is the one case that needs the hop-by-hop set.
 *
 * `Connection: Upgrade` and `Upgrade: websocket` ARE the request -- stripping
 * them the way an ordinary forward does would turn a handshake into a plain GET.
 */
export function upgradeRequestHeaders(
  req: http.IncomingMessage,
  defaultDirectory?: string,
): OutgoingHeaders {
  const headers = buildRequestHeaders(req, false, defaultDirectory);
  for (const name of ["connection", "upgrade", "sec-websocket-key", "sec-websocket-version",
    "sec-websocket-protocol", "sec-websocket-extensions"]) {
    const value = req.headers[name];
    if (value !== undefined) headers[name] = value;
  }
  return headers;
}

export function forwardUpgrade(
  req: http.IncomingMessage,
  clientSocket: Duplex,
  head: Buffer,
  options: ForwardOptions,
): void {
  const proxyReq = http.request({
    host: options.targetHost ?? DEFAULT_TARGET_HOST,
    port: options.targetPort,
    path: req.url || "/",
    method: req.method,
    headers: upgradeRequestHeaders(req, options.defaultDirectory),
  });

  proxyReq.on("upgrade", (proxyRes, proxySocket, proxyHead) => {
    const lines = [`HTTP/1.1 ${proxyRes.statusCode} ${proxyRes.statusMessage}`];
    for (const [key, value] of Object.entries(proxyRes.headers)) {
      if (value === undefined) continue;
      if (Array.isArray(value)) {
        for (const entry of value) lines.push(`${key}: ${entry}`);
      } else {
        lines.push(`${key}: ${value}`);
      }
    }
    clientSocket.write(lines.join("\r\n") + "\r\n\r\n");

    if (proxyHead && proxyHead.length > 0) clientSocket.unshift(proxyHead);

    // Tie the two sockets' lifetimes together. Without the `close` handlers a
    // phone dropping off the tunnel would leave the upstream socket open.
    const teardown = () => {
      proxySocket.destroy();
      clientSocket.destroy();
    };
    proxySocket.on("error", teardown);
    proxySocket.on("close", teardown);
    clientSocket.on("error", teardown);
    clientSocket.on("close", teardown);

    proxySocket.pipe(clientSocket);
    clientSocket.pipe(proxySocket);
  });

  proxyReq.on("error", (error: Error) => {
    console.error("[Proxy] Upgrade failed:", error.message);
    clientSocket.destroy();
  });

  if (head && head.length > 0) proxyReq.write(head);
  proxyReq.end();
}
