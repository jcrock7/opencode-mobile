/**
 * auth.test.ts - the gate on the plugin's own endpoints.
 *
 * These endpoints are answered before anything reaches OpenCode, so
 * OPENCODE_SERVER_PASSWORD never saw them. The tests are written around the two
 * things that were actually reachable unauthenticated: registering a device to
 * receive someone else's notifications, and opening a public tunnel to an
 * arbitrary local port.
 */

import { describe, it, expect } from "vitest";
import {
  loadAuthConfig,
  parseBasicAuth,
  credentialsMatch,
  guardPluginRoute,
  tunnelTargetAllowed,
  UNAUTHORIZED_HEADERS,
  type AuthConfig,
} from "./auth";

const CONFIG: AuthConfig = { password: "s3cret", username: "opencode" };
const OPEN: AuthConfig = { password: null, username: "opencode" };

function basic(user: string, pass: string): string {
  return "Basic " + Buffer.from(`${user}:${pass}`).toString("base64");
}

describe("loadAuthConfig", () => {
  it("reads OpenCode's own password and default username", () => {
    expect(loadAuthConfig({ OPENCODE_SERVER_PASSWORD: "hunter2" })).toEqual({
      password: "hunter2",
      username: "opencode",
    });
  });

  it("honours a custom username", () => {
    expect(
      loadAuthConfig({ OPENCODE_SERVER_PASSWORD: "x", OPENCODE_SERVER_USERNAME: "jared" }).username,
    ).toBe("jared");
  });

  it("treats an unset or empty password as no password", () => {
    expect(loadAuthConfig({}).password).toBeNull();
    expect(loadAuthConfig({ OPENCODE_SERVER_PASSWORD: "" }).password).toBeNull();
  });
});

describe("parseBasicAuth", () => {
  it("splits a well-formed header", () => {
    expect(parseBasicAuth(basic("opencode", "s3cret"))).toEqual({
      username: "opencode",
      password: "s3cret",
    });
  });

  it("keeps colons in the password", () => {
    // Only the first colon separates; RFC 7617 forbids one in the username.
    expect(parseBasicAuth(basic("opencode", "a:b:c"))?.password).toBe("a:b:c");
  });

  it("accepts the scheme in any case", () => {
    const header = basic("opencode", "s3cret").replace("Basic", "basic");
    expect(parseBasicAuth(header)?.username).toBe("opencode");
  });

  it.each([
    ["missing", undefined],
    ["a bearer token", "Bearer abc123"],
    ["a bare scheme", "Basic"],
    ["not base64 with a colon", "Basic " + Buffer.from("nocolon").toString("base64")],
    ["empty", ""],
  ])("returns null for %s", (_label, header) => {
    expect(parseBasicAuth(header as string | undefined)).toBeNull();
  });

  it("refuses a repeated Authorization header rather than picking one", () => {
    // Two credentials in one request is ambiguous; resolving it by choosing is
    // how a proxy and its upstream end up disagreeing about who the caller is.
    expect(parseBasicAuth([basic("opencode", "s3cret"), basic("evil", "x")])).toBeNull();
  });
});

describe("credentialsMatch", () => {
  it("accepts the configured pair", () => {
    expect(credentialsMatch(basic("opencode", "s3cret"), CONFIG)).toBe(true);
  });

  it("rejects a wrong password", () => {
    expect(credentialsMatch(basic("opencode", "wrong"), CONFIG)).toBe(false);
  });

  it("rejects a wrong username", () => {
    expect(credentialsMatch(basic("root", "s3cret"), CONFIG)).toBe(false);
  });

  it("rejects a password that is a prefix of the real one", () => {
    expect(credentialsMatch(basic("opencode", "s3cre"), CONFIG)).toBe(false);
  });

  it("never matches when no password is configured", () => {
    // Otherwise an empty configured password would accept an empty supplied
    // one, which is worse than having no gate at all.
    expect(credentialsMatch(basic("opencode", ""), OPEN)).toBe(false);
  });
});

describe("tunnelTargetAllowed", () => {
  const allowed = [4097, 4096];

  it("allows a body that names no port", () => {
    expect(tunnelTargetAllowed({}, allowed)).toBe(true);
    expect(tunnelTargetAllowed({ port: undefined }, allowed)).toBe(true);
    expect(tunnelTargetAllowed(null, allowed)).toBe(true);
  });

  it("allows the two ports this process owns", () => {
    expect(tunnelTargetAllowed({ port: 4097 }, allowed)).toBe(true);
    expect(tunnelTargetAllowed({ port: 4096 }, allowed)).toBe(true);
  });

  it.each([22, 5432, 6379, 8080, 3000, 1])("refuses local service port %i", (port) => {
    // This is the finding: the endpoint published a caller-chosen local port
    // and returned the new public URL in the response.
    expect(tunnelTargetAllowed({ port }, allowed)).toBe(false);
  });

  it("refuses a port that is not an integer", () => {
    for (const port of ["4097; rm -rf /", 4097.5, NaN, Infinity, "abc", {}, []]) {
      expect(tunnelTargetAllowed({ port }, allowed)).toBe(false);
    }
  });

  it("accepts a numeric string for an allowed port", () => {
    // JSON from a hand-rolled client often stringifies numbers.
    expect(tunnelTargetAllowed({ port: "4096" }, allowed)).toBe(true);
  });
});

describe("guardPluginRoute", () => {
  const base = { allowedTunnelPorts: [4097, 4096] };

  it("refuses an unauthenticated push-token registration", () => {
    // The vulnerability in one assertion: registering a device here redirects
    // the server's notifications, whose bodies quote the agent's last message.
    const guard = guardPluginRoute({
      ...base,
      route: "push-token",
      method: "POST",
      authorization: undefined,
      config: CONFIG,
    });
    expect(guard).toEqual({ allowed: false, status: 401, reason: "authentication required" });
  });

  it("refuses an unauthenticated tunnel read", () => {
    const guard = guardPluginRoute({
      ...base,
      route: "tunnel",
      method: "GET",
      authorization: undefined,
      config: CONFIG,
    });
    expect(guard.allowed).toBe(false);
  });

  it("refuses wrong credentials", () => {
    const guard = guardPluginRoute({
      ...base,
      route: "push-token",
      method: "POST",
      authorization: basic("opencode", "guess"),
      config: CONFIG,
    });
    expect(guard.allowed).toBe(false);
  });

  it("admits the configured credentials", () => {
    const guard = guardPluginRoute({
      ...base,
      route: "push-token",
      method: "POST",
      authorization: basic("opencode", "s3cret"),
      config: CONFIG,
    });
    expect(guard).toEqual({ allowed: true });
  });

  it("refuses a disallowed tunnel port even with valid credentials", () => {
    // Not an authentication question: there is no legitimate reason for any
    // caller to publish a port this process does not own.
    const guard = guardPluginRoute({
      ...base,
      route: "tunnel",
      method: "POST",
      authorization: basic("opencode", "s3cret"),
      config: CONFIG,
      body: { port: 5432 },
    });
    expect(guard).toEqual({ allowed: false, status: 403, reason: "tunnel target port not allowed" });
  });

  it("still refuses a disallowed tunnel port when no password is configured", () => {
    const guard = guardPluginRoute({
      ...base,
      route: "tunnel",
      method: "POST",
      authorization: undefined,
      config: OPEN,
      body: { port: 22 },
    });
    expect(guard.allowed).toBe(false);
    expect(guard).toMatchObject({ status: 403 });
  });

  it("leaves the endpoints open when no password is configured", () => {
    // Requiring credentials nobody has been told to set would lock out every
    // existing install; the startup log warns instead.
    const guard = guardPluginRoute({
      ...base,
      route: "push-token",
      method: "POST",
      authorization: undefined,
      config: OPEN,
    });
    expect(guard).toEqual({ allowed: true });
  });

  it("does not check the port on a tunnel read", () => {
    const guard = guardPluginRoute({
      ...base,
      route: "tunnel",
      method: "GET",
      authorization: basic("opencode", "s3cret"),
      config: CONFIG,
      body: { port: 22 },
    });
    expect(guard.allowed).toBe(true);
  });
});

describe("the 401 response", () => {
  it("challenges, so the phone offers its saved credentials", () => {
    // Without WWW-Authenticate the browser shows a bare error and the PWA has
    // no way back in.
    expect(UNAUTHORIZED_HEADERS["WWW-Authenticate"]).toContain("Basic");
    expect(UNAUTHORIZED_HEADERS["WWW-Authenticate"]).toContain("realm");
  });
});
