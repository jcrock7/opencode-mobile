/**
 * What this plugin instance is for.
 *
 * OpenCode loads plugins per instance, in whichever process resolved that
 * instance -- and there can be several processes on one machine: a desktop app
 * driving its own sidecar, a TUI session, `opencode run` one-offs, and your own
 * `opencode serve`. Only one of them can own the plugin port and the tunnel.
 *
 * That mattered more than it looks. The plugin used to return a no-op event
 * handler in every process that was not the one serving, and again in a serving
 * process that lost the port race. Since the event hook is in-process -- it is
 * called on the bus of the process the plugin was loaded into, not over HTTP --
 * a question or a permission request asked by an agent in any OTHER process
 * reached nobody. No notification, and no way to find out from the phone
 * either: a pending request is held in an in-memory map inside the process that
 * asked it, so the serving process cannot see it over the API and cannot
 * report it.
 *
 * Sending a push needs neither the plugin's server nor the tunnel: the tokens
 * are a file on disk and Expo is an outbound HTTPS call, and the URL a
 * notification deep-links to is read back from the tunnel metadata that the
 * serving process wrote. So a non-serving process CAN notify, and there is no
 * technical reason for it to stay silent.
 *
 * It stays silent by default anyway, because "notify from everywhere" is a
 * different product: sitting at a TUI, a push for every turn you just watched
 * finish is noise. `OPENCODE_MOBILE_NOTIFY_ALWAYS=1` opts in -- set it where
 * the agent actually runs.
 */

export type PluginRole =
  /** Owns the plugin port, the tunnel and the overlay, and notifies. */
  | "serve"
  /** Notifies only. No server, no tunnel, no overlay. */
  | "notify-only"
  /** Does nothing. */
  | "idle";

export interface RoleInput {
  argv: readonly string[];
  env: NodeJS.ProcessEnv;
}

function isEnabled(value: string | undefined): boolean {
  if (value === undefined) return false;
  const normalized = value.trim().toLowerCase();
  return (
    normalized === "1" ||
    normalized === "true" ||
    normalized === "on" ||
    normalized === "yes"
  );
}

/** Opt in to notifying from a process that is not the one serving. */
export function notifiesAlways(env: NodeJS.ProcessEnv = process.env): boolean {
  return isEnabled(env.OPENCODE_MOBILE_NOTIFY_ALWAYS);
}

/**
 * Whether this process was started to serve.
 *
 * Gated on the literal `serve` token in argv rather than on `ctx.serverUrl`,
 * which is present for other commands too (`opencode debug wait`) and would
 * start a tunnel nobody asked for. `attach` excludes the case where `serve`
 * appears as an argument to something else.
 */
export function isServeInvocation(argv: readonly string[]): boolean {
  return argv.includes("serve") && !argv.includes("attach");
}

export function resolvePluginRole(input: RoleInput): PluginRole {
  if (isServeInvocation(input.argv)) return "serve";
  return notifiesAlways(input.env) ? "notify-only" : "idle";
}

/**
 * What a serving process becomes when another one already holds the port.
 *
 * Two servers on one port is not a state to recover from -- the other process
 * is serving and this one should not try -- but it is also not a reason to stop
 * watching the bus of the process the agent may be running in.
 */
export function roleWithoutPort(
  env: NodeJS.ProcessEnv = process.env,
): PluginRole {
  return notifiesAlways(env) ? "notify-only" : "idle";
}

/** One line for the startup log, so the role is never a guess. */
export function describeRole(role: PluginRole): string {
  if (role === "serve")
    return "serving: plugin port, tunnel, overlay and notifications";
  if (role === "notify-only") {
    return "notifications only (OPENCODE_MOBILE_NOTIFY_ALWAYS): no server, no tunnel";
  }
  return "idle: not serving, and OPENCODE_MOBILE_NOTIFY_ALWAYS is not set";
}
