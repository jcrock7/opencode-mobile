/**
 * Overlay asset serving
 */

import * as crypto from "crypto";
import type * as http from "http";
import type { OverlayAsset, OverlayConfig } from "./types";
import { OVERLAY_CSS_PATH, OVERLAY_JS_PATH } from "./config";
import { buildOverlayCss } from "./mobile-css";
import { buildOverlayJs } from "./mobile-js";

function etagFor(body: string): string {
  const hash = crypto.createHash("sha256").update(body).digest("base64url").slice(0, 27);
  return `W/"${hash}"`;
}

export function buildAsset(body: string, contentType: string): OverlayAsset {
  return { body, contentType, etag: etagFor(body) };
}

/**
 * Build both assets for a config. Cached per config so a page load does not
 * re-hash the payloads on every request.
 */
const cache = new Map<string, Map<string, OverlayAsset>>();

function cacheKey(config: OverlayConfig): string {
  return [
    config.maxWidth,
    config.sessionStrip ? 1 : 0,
    config.statusBar ? 1 : 0,
    config.keyboardViewport ? 1 : 0,
    config.debug ? 1 : 0,
  ].join(":");
}

export function overlayAssets(config: OverlayConfig): Map<string, OverlayAsset> {
  const key = cacheKey(config);
  const hit = cache.get(key);
  if (hit) return hit;

  const assets = new Map<string, OverlayAsset>([
    [OVERLAY_CSS_PATH, buildAsset(buildOverlayCss(config), "text/css; charset=utf-8")],
    [OVERLAY_JS_PATH, buildAsset(buildOverlayJs(config), "text/javascript; charset=utf-8")],
  ]);
  cache.set(key, assets);
  return assets;
}

/** Test helper: drop the memoised assets. */
export function clearAssetCache(): void {
  cache.clear();
}

export function getOverlayAsset(pathname: string, config: OverlayConfig): OverlayAsset | null {
  return overlayAssets(config).get(pathname) ?? null;
}

/**
 * Serve an overlay asset. Returns false when the path is not ours, so the
 * caller can fall through to the proxy.
 */
export function handleOverlayAsset(
  pathname: string,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  config: OverlayConfig,
): boolean {
  const asset = getOverlayAsset(pathname, config);
  if (!asset) return false;

  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405, { allow: "GET, HEAD" });
    res.end();
    return true;
  }

  const headers: Record<string, string> = {
    "content-type": asset.contentType,
    etag: asset.etag,
    // The payload changes only when the plugin is upgraded or reconfigured, but
    // it is generated rather than fingerprinted, so revalidate rather than
    // letting a stale copy stick around on the phone.
    "cache-control": "no-cache",
  };

  if (req.headers["if-none-match"] === asset.etag) {
    res.writeHead(304, headers);
    res.end();
    return true;
  }

  headers["content-length"] = String(Buffer.byteLength(asset.body));

  if (req.method === "HEAD") {
    res.writeHead(200, headers);
    res.end();
    return true;
  }

  res.writeHead(200, headers);
  res.end(asset.body);
  return true;
}
