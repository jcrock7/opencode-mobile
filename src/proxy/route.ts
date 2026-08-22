/**
 * Request routing for the plugin server.
 *
 * Kept as a pure function so the routing contract -- which requests stay local,
 * which reach OpenCode -- is verifiable without standing up a server. Getting
 * this wrong is how you silently break the app: swallow `/session` and the UI
 * has no data; swallow an API preflight and its CORS never runs.
 */

import { isOverlayAssetPath } from "../overlay/config";

export type Route =
  | { kind: "cors-preflight" }
  | { kind: "push-token" }
  | { kind: "tunnel" }
  | { kind: "overlay-asset" }
  | { kind: "forward" };

export interface RouteInput {
  pathname: string;
  method: string | undefined;
  overlayEnabled: boolean;
}

/**
 * Match a path segment prefix, not a raw string prefix.
 *
 * A bare `startsWith("/tunnel")` also captures `/tunnelling`, and
 * `startsWith("/push-token")` captures `/push-tokens-report`. That was
 * harmless while every unmatched path returned 404, but now that the plugin
 * fronts the whole OpenCode API it would silently swallow real routes.
 */
function matchesPrefix(pathname: string, prefix: string): boolean {
  if (pathname === prefix) return true;
  return pathname.startsWith(prefix + "/");
}

const PUSH_TOKEN_PREFIX = "/push-token";
const TUNNEL_PREFIX = "/tunnel";

/** Endpoints the plugin answers itself rather than forwarding. */
function isPluginRoute(pathname: string): boolean {
  return matchesPrefix(pathname, PUSH_TOKEN_PREFIX) || matchesPrefix(pathname, TUNNEL_PREFIX);
}

export function routeRequest(input: RouteInput): Route {
  const { pathname, method, overlayEnabled } = input;

  // Only the plugin's own endpoints get a canned preflight. A preflight aimed
  // at the OpenCode API has to reach OpenCode so its own CORS handling runs.
  if (method === "OPTIONS" && isPluginRoute(pathname)) return { kind: "cors-preflight" };

  if (matchesPrefix(pathname, PUSH_TOKEN_PREFIX)) return { kind: "push-token" };
  if (matchesPrefix(pathname, TUNNEL_PREFIX)) return { kind: "tunnel" };
  if (overlayEnabled && isOverlayAssetPath(pathname)) return { kind: "overlay-asset" };

  return { kind: "forward" };
}
