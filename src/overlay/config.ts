/**
 * Overlay configuration
 */

import type { OverlayConfig } from "./types";

/**
 * Asset routes. Namespaced under a prefix OpenCode does not use, so the
 * proxy can claim them without shadowing an app route or an API path.
 */
export const OVERLAY_ROUTE_PREFIX = "/__oc-mobile/";
export const OVERLAY_CSS_PATH = "/__oc-mobile/overlay.css";
export const OVERLAY_JS_PATH = "/__oc-mobile/overlay.js";

export const DEFAULT_MAX_WIDTH = 767;

const DEFAULT_CONFIG: OverlayConfig = {
  enabled: true,
  sessionStrip: true,
  maxWidth: DEFAULT_MAX_WIDTH,
};

/**
 * Env values that mean "off". Anything else (including unset) leaves the
 * default in place, so the overlay is opt-out rather than opt-in.
 */
function isDisabled(value: string | undefined): boolean {
  if (value === undefined) return false;
  const normalized = value.trim().toLowerCase();
  return normalized === "0" || normalized === "false" || normalized === "off" || normalized === "no";
}

function parseMaxWidth(value: string | undefined): number | null {
  if (value === undefined) return null;
  const parsed = Number(value.trim());
  if (!Number.isFinite(parsed)) return null;
  // A breakpoint outside this range is a typo, not an intent.
  if (parsed < 320 || parsed > 2560) return null;
  return Math.floor(parsed);
}

export function loadOverlayConfig(env: NodeJS.ProcessEnv = process.env): OverlayConfig {
  const maxWidth = parseMaxWidth(env.OPENCODE_MOBILE_OVERLAY_MAX_WIDTH);
  return {
    enabled: !isDisabled(env.OPENCODE_MOBILE_OVERLAY),
    sessionStrip: !isDisabled(env.OPENCODE_MOBILE_OVERLAY_STRIP),
    maxWidth: maxWidth ?? DEFAULT_CONFIG.maxWidth,
  };
}

export function isOverlayAssetPath(pathname: string): boolean {
  return pathname === OVERLAY_CSS_PATH || pathname === OVERLAY_JS_PATH;
}

/** Strip query/hash so route matching works on the path alone. */
export function pathnameOf(url: string): string {
  const queryIndex = url.search(/[?#]/);
  return queryIndex === -1 ? url : url.slice(0, queryIndex);
}
