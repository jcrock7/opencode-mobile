#!/usr/bin/env node
/**
 * `npm run serve` -- start OpenCode and wake the plugin.
 *
 * Why this exists
 * ---------------
 * `opencode serve` loads no plugins on startup. Its own source says why:
 *
 *     // Server loads instances per-request via x-opencode-directory header --
 *     // no need for an ambient project InstanceContext at startup.
 *     instance: false,
 *
 * Plugins are instance-scoped, so until a request arrives there is no instance
 * and therefore no plugin: nothing on the plugin port, no tunnel, no banner.
 *
 * That is normally invisible, because opening the web UI is a request. It is
 * only a problem for this plugin, because the thing the plugin starts is the
 * tunnel you were going to reach it through -- so you cannot use the tunnel to
 * trigger the tunnel. The documented workaround was to curl the server by hand
 * from a second terminal, which is a step nobody should have to remember.
 *
 * So: run the same command, watch its output for the line where it reports the
 * address it actually bound, and make that one request. Reading the port from
 * the output rather than assuming 4096 also handles the case where 4096 was
 * taken and OpenCode quietly bound something else -- which is its own
 * confusing failure, since the tunnel then points at a port nothing is on.
 *
 * Everything the child prints is passed through untouched.
 */

import { spawn } from "child_process";

const DEFAULT_PORT = Number(process.env.OPENCODE_PORT) || 4096;
const WAKE_TIMEOUT_MS = 30_000;
const WAKE_RETRY_MS = 300;

// Overridable so this script can be tested without OpenCode installed.
const command = process.env.OPENCODE_MOBILE_SERVE_CMD || "opencode";
const directory = process.env.OPENCODE_MOBILE_SERVE_DIR || process.cwd();

const password = process.env.OPENCODE_SERVER_PASSWORD || "";
const username = process.env.OPENCODE_SERVER_USERNAME || "opencode";

const note = (message) => console.log(`[serve] ${message}`);

/**
 * Pull the bound address out of OpenCode's own startup line:
 *
 *   opencode server listening on http://127.0.0.1:4096
 *
 * Exported shape kept simple and pure so it is checkable in isolation.
 */
export function parseListenUrl(text) {
  const match = /listening on\s+(https?:\/\/[^\s]+)/i.exec(text);
  return match ? match[1].replace(/\/+$/, "") : null;
}

async function wake(baseUrl) {
  const url = `${baseUrl}/session?directory=${encodeURIComponent(directory)}`;
  const headers = password
    ? { authorization: "Basic " + Buffer.from(`${username}:${password}`).toString("base64") }
    : {};

  const deadline = Date.now() + WAKE_TIMEOUT_MS;
  let lastError = "";

  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { headers });
      // Any answer means the server resolved an instance for this directory,
      // which is the whole point -- the plugin has loaded. A 401 means it
      // refused us, and the instance may not have been created, so that is
      // worth calling out rather than treating as success.
      if (res.status === 401) {
        note(
          "the server answered 401. Set OPENCODE_SERVER_PASSWORD in this shell so the " +
            "wake-up request can authenticate, or open the UI once yourself.",
        );
        return false;
      }
      note(`plugin woken via ${baseUrl} (HTTP ${res.status})`);
      return true;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      await new Promise((resolve) => setTimeout(resolve, WAKE_RETRY_MS));
    }
  }

  note(`could not reach ${baseUrl} to wake the plugin (${lastError})`);
  note("the server is still running; open the UI once, or run the curl in the README.");
  return false;
}

const child = spawn(command, ["serve", ...process.argv.slice(2)], {
  stdio: ["inherit", "pipe", "pipe"],
  env: process.env,
});

let woken = false;
let buffered = "";

function watch(stream, sink) {
  stream.setEncoding("utf-8");
  stream.on("data", (chunk) => {
    sink.write(chunk);
    if (woken) return;
    // Keep a rolling tail: the line can be split across chunks.
    buffered = (buffered + chunk).slice(-4096);
    const url = parseListenUrl(buffered);
    if (!url) return;
    woken = true;
    void wake(url);
  });
}

watch(child.stdout, process.stdout);
watch(child.stderr, process.stderr);

// If OpenCode ever stops printing that line, still make the attempt rather than
// silently leaving the tunnel down.
const fallback = setTimeout(() => {
  if (woken) return;
  woken = true;
  note(`no listening address in the output; trying 127.0.0.1:${DEFAULT_PORT}`);
  void wake(`http://127.0.0.1:${DEFAULT_PORT}`);
}, 3_000);

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    child.kill(signal);
  });
}

child.on("exit", (code, signal) => {
  clearTimeout(fallback);
  if (signal) {
    process.exit(1);
  }
  process.exit(code ?? 0);
});

child.on("error", (error) => {
  clearTimeout(fallback);
  console.error(`[serve] failed to start "${command}": ${error.message}`);
  process.exit(1);
});
