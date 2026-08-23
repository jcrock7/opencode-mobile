/**
 * Authentication for the plugin's own endpoints.
 *
 * The plugin is a reverse proxy in front of OpenCode, and it answers three
 * paths itself before anything reaches OpenCode: `/push-token`, `/tunnel` and
 * `/__oc-mobile/*`. OpenCode's `OPENCODE_SERVER_PASSWORD` therefore does not
 * protect them -- the request never gets that far. Anything the tunnel can
 * reach, it can reach unauthenticated.
 *
 * That mattered:
 *
 *   POST /push-token   registers a device to receive this server's push
 *                      notifications, whose bodies quote the agent's last
 *                      message. An attacker's phone gets your session output.
 *   DELETE /push-token deregisters your real device.
 *   POST /tunnel       opens a new public tunnel to a caller-chosen local port
 *                      and returns the public URL in the response body. That is
 *                      an arbitrary-local-service exposure primitive, not just
 *                      an authentication bypass.
 *
 * Kept as pure functions, like `route.ts`, because `index.ts` is untestable in
 * place -- which is exactly how this got shipped without anyone noticing.
 */

import * as crypto from "crypto";

export interface AuthConfig {
  /** OpenCode's own Basic password, when one is configured. */
  password: string | null;
  /** OpenCode defaults the username to "opencode". */
  username: string;
}

export function loadAuthConfig(env: NodeJS.ProcessEnv = process.env): AuthConfig {
  const password = env.OPENCODE_SERVER_PASSWORD;
  return {
    password: typeof password === "string" && password.length > 0 ? password : null,
    username: env.OPENCODE_SERVER_USERNAME || "opencode",
  };
}

/**
 * Compare two strings without leaking their contents through timing.
 *
 * Hashed first so the comparison is over equal-length buffers:
 * `timingSafeEqual` throws on a length mismatch, and branching on length to
 * avoid that would itself leak the password's length.
 */
function constantTimeEqual(a: string, b: string): boolean {
  const ha = crypto.createHash("sha256").update(a, "utf8").digest();
  const hb = crypto.createHash("sha256").update(b, "utf8").digest();
  return crypto.timingSafeEqual(ha, hb);
}

/** Parse an `Authorization: Basic ...` header into its two halves. */
export function parseBasicAuth(
  header: string | string[] | undefined,
): { username: string; password: string } | null {
  // Node only ever arrays a few headers, but a repeated Authorization is
  // ambiguous and must not be resolved by picking one.
  if (typeof header !== "string") return null;
  const match = /^Basic\s+(\S+)$/i.exec(header.trim());
  if (!match) return null;
  let decoded: string;
  try {
    decoded = Buffer.from(match[1], "base64").toString("utf8");
  } catch {
    return null;
  }
  // The password may itself contain a colon; the username may not.
  const split = decoded.indexOf(":");
  if (split === -1) return null;
  return { username: decoded.slice(0, split), password: decoded.slice(split + 1) };
}

export function credentialsMatch(
  header: string | string[] | undefined,
  config: AuthConfig,
): boolean {
  if (!config.password) return false;
  const parsed = parseBasicAuth(header);
  if (!parsed) return false;
  // Both compared in constant time: a wrong username must not be cheaper to
  // detect than a wrong password.
  const userOk = constantTimeEqual(parsed.username, config.username);
  const passOk = constantTimeEqual(parsed.password, config.password);
  return userOk && passOk;
}

export type PluginRouteKind = "push-token" | "tunnel";

export type Guard =
  | { allowed: true }
  | { allowed: false; status: 401 | 403; reason: string };

export interface GuardInput {
  route: PluginRouteKind;
  method: string | undefined;
  authorization: string | string[] | undefined;
  config: AuthConfig;
  /** Ports a tunnel may legitimately target: OpenCode's and the plugin's own. */
  allowedTunnelPorts: number[];
  /** Parsed request body for POST /tunnel, when there is one. */
  body?: unknown;
}

/**
 * Ports the plugin will open a tunnel to.
 *
 * Enforced whether or not a password is set, because it is not an
 * authentication question. There is no legitimate reason for a caller to name a
 * port -- the only ones that make sense are the two this process already knows
 * -- and honouring an arbitrary one turns the plugin into a way to publish any
 * service on the loopback interface.
 */
export function tunnelTargetAllowed(body: unknown, allowed: number[]): boolean {
  if (!body || typeof body !== "object") return true; // no port named: the default is used
  const raw = (body as { port?: unknown }).port;
  if (raw === undefined || raw === null) return true;
  const port = Number(raw);
  if (!Number.isInteger(port)) return false;
  return allowed.includes(port);
}

export function guardPluginRoute(input: GuardInput): Guard {
  const { route, method, authorization, config, allowedTunnelPorts, body } = input;

  // A configured password is a statement that this server is not public. The
  // plugin's own routes have to honour it, since OpenCode never sees them.
  if (config.password && !credentialsMatch(authorization, config)) {
    return { allowed: false, status: 401, reason: "authentication required" };
  }

  if (route === "tunnel" && method === "POST" && !tunnelTargetAllowed(body, allowedTunnelPorts)) {
    return {
      allowed: false,
      status: 403,
      reason: "tunnel target port not allowed",
    };
  }

  return { allowed: true };
}

/**
 * CORS headers for the plugin's own endpoints.
 *
 * Deliberately no `Access-Control-Allow-Origin`. The consumer is the native
 * mobile app, which is not a browser and never enforces CORS, so a wildcard
 * bought nothing -- while letting any page the user visited POST JSON to
 * `http://127.0.0.1:<pluginPort>/tunnel` cross-origin and read the reply.
 *
 * Exported rather than written out at each call site: the integration harness
 * kept its own copy and had already drifted from the real one.
 */
export const PLUGIN_CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  Vary: "Origin",
};

/**
 * Headers for a 401.
 *
 * `WWW-Authenticate` is what makes a browser offer its saved credentials
 * instead of showing a bare error, so the phone re-authenticates by itself.
 */
export const UNAUTHORIZED_HEADERS: Record<string, string> = {
  "WWW-Authenticate": 'Basic realm="opencode", charset="UTF-8"',
  "Content-Type": "application/json",
};
