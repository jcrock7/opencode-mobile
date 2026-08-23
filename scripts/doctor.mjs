#!/usr/bin/env node
/**
 * Diagnose why the mobile overlay is not showing up.
 *
 * Walks the whole chain in order and reports where it breaks:
 *
 *   config registers the plugin
 *     -> the build exists and is current
 *       -> OpenCode is listening
 *         -> the plugin is listening
 *           -> the plugin serves and injects the overlay
 *             -> the tunnel points at the PLUGIN, not at OpenCode
 *               -> the public URL serves the overlay
 *
 * Read-only. Prints no secrets.
 *
 *   npm run doctor
 */

import { existsSync, readFileSync, statSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { homedir } from "node:os";
import { execSync } from "node:child_process";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const selfSpec = pathToFileURL(repoRoot).href;
const configDir = join(homedir(), ".config", "opencode");

const OPENCODE_PORT = Number(process.env.OPENCODE_PORT) || 4096;
const PLUGIN_PORT = OPENCODE_PORT + 1;

let problems = 0;
const ok = (m) => console.log(`  ok    ${m}`);
const bad = (m) => { problems++; console.log(`  FAIL  ${m}`); };
const warn = (m) => console.log(`  warn  ${m}`);
const info = (m) => console.log(`        ${m}`);
const section = (m) => console.log(`\n${m}`);

/**
 * Listening TCP ports, via ss or lsof. Used to spot a stale `opencode serve`
 * holding 4096 -- when that happens OpenCode silently falls back to a random
 * port and the plugin follows it, so probing 4096/4097 tells you about the OLD
 * instance rather than the one you just started.
 */
function listeningPorts() {
  const out = [];
  const tryCmd = (cmd) => {
    try {
      return execSync(cmd, { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] });
    } catch {
      return "";
    }
  };
  let raw = tryCmd("ss -ltnp 2>/dev/null");
  if (raw) {
    for (const line of raw.split("\n").slice(1)) {
      const port = line.match(/:(\d+)\s/);
      const proc = line.match(/users:\(\("([^"]+)",pid=(\d+)/);
      if (port) out.push({ port: Number(port[1]), name: proc?.[1] ?? "?", pid: proc?.[2] ?? "?" });
    }
    return out;
  }
  raw = tryCmd("lsof -iTCP -sTCP:LISTEN -P -n 2>/dev/null");
  for (const line of raw.split("\n").slice(1)) {
    const cols = line.split(/\s+/);
    const port = line.match(/:(\d+)\s*\(LISTEN\)/);
    if (port) out.push({ port: Number(port[1]), name: cols[0] ?? "?", pid: cols[1] ?? "?" });
  }
  return out;
}

function opencodeProcesses() {
  try {
    const raw = execSync("ps -eo pid=,args= 2>/dev/null", {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return raw
      .split("\n")
      .filter((l) => /opencode/.test(l) && /\bserve\b/.test(l) && !/doctor\.mjs|grep/.test(l))
      .map((l) => l.trim());
  } catch {
    return [];
  }
}

function readJson(path) {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf-8").replace(/^\s*\/\/.*$/gm, ""));
  } catch {
    return undefined;
  }
}

async function probe(url, { timeout = 4000, headers = {} } = {}) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeout);
  try {
    const res = await fetch(url, { signal: ac.signal, headers, redirect: "manual" });
    const text = await res.text().catch(() => "");
    return { status: res.status, headers: res.headers, body: text };
  } catch (e) {
    return { error: e.name === "AbortError" ? "timeout" : e.message };
  } finally {
    clearTimeout(t);
  }
}

console.log("opencode-mobile doctor");
console.log(`repo: ${repoRoot}`);

/* ---------- 1. plugin registration ---------- */
section("1. plugin registration");
const jsoncPath = join(configDir, "opencode.jsonc");
const jsonPath = join(configDir, "opencode.json");
const activeConfig = existsSync(jsoncPath) ? jsoncPath : existsSync(jsonPath) ? jsonPath : null;

if (!activeConfig) {
  bad(`no config at ${jsonPath} (or .jsonc)`);
  info(`fix: npm run print-config -- --merge`);
} else {
  info(`config: ${activeConfig}`);
  if (existsSync(jsoncPath) && existsSync(jsonPath)) {
    warn(`both .jsonc and .json exist -- OpenCode reads .jsonc and ignores .json`);
  }
  const cfg = readJson(activeConfig);
  if (cfg === undefined) {
    bad(`config is not valid JSON`);
  } else {
    const plugins = Array.isArray(cfg.plugin) ? cfg.plugin : [];
    info(`plugin: ${JSON.stringify(plugins)}`);
    const mine = plugins.filter((p) => String(p).startsWith("file://"));
    const npmSpec = plugins.filter((p) => String(p).startsWith("opencode-mobile@"));

    if (!plugins.length) {
      bad(`plugin array is empty -- nothing is loaded`);
      info(`fix: npm run print-config -- --merge`);
    }
    if (npmSpec.length && !mine.length) {
      bad(`only the upstream npm package is registered: ${JSON.stringify(npmSpec)}`);
      info(`that package does not contain the overlay -- this is very likely your problem`);
      info(`fix: npm run print-config -- --merge`);
    }
    if (npmSpec.length && mine.length) {
      bad(`both the npm package and a local checkout are registered`);
      info(`two copies of the plugin will contend for port ${PLUGIN_PORT}`);
      info(`fix: npm run print-config -- --merge`);
    }
    for (const spec of mine) {
      if (spec === selfSpec) {
        ok(`registered as ${spec}`);
      } else {
        warn(`registered path is not this checkout:`);
        info(`  config says: ${spec}`);
        info(`  this repo:   ${selfSpec}`);
      }
      const dir = fileURLToPath(spec);
      if (!existsSync(dir)) bad(`that path does not exist on disk`);
      else if (!existsSync(join(dir, "dist", "index.js"))) {
        bad(`${join(dir, "dist", "index.js")} is missing -- run npm run build there`);
      }
    }
  }
}

/* ---------- 2. build ---------- */
section("2. build");
const distEntry = join(repoRoot, "dist", "index.js");
if (!existsSync(distEntry)) {
  bad(`dist/index.js missing -- run: npm run build`);
} else {
  const distTime = statSync(distEntry).mtimeMs;
  let newest = 0;
  let newestFile = "";
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.name === "node_modules" || e.name === "dist" || e.name.startsWith(".")) continue;
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith(".ts") && !e.name.endsWith(".test.ts")) {
        const m = statSync(p).mtimeMs;
        if (m > newest) { newest = m; newestFile = p; }
      }
    }
  };
  walk(repoRoot);
  if (newest > distTime) {
    bad(`dist is older than source (${newestFile.replace(repoRoot + "/", "")}) -- run: npm run build`);
  } else {
    ok(`dist/index.js is current`);
  }
  const overlay = join(repoRoot, "dist", "src", "overlay", "serve.js");
  if (!existsSync(overlay)) bad(`dist/src/overlay/ missing -- this build predates the overlay`);
  else ok(`overlay module present in the build`);
}

/* ---------- 3. instances ---------- */
section("3. running instances");
const procs = opencodeProcesses();
if (procs.length === 0) {
  warn(`no 'opencode serve' process found -- start one before trusting the checks below`);
} else {
  for (const p of procs) info(p.slice(0, 150));
  if (procs.length > 1) {
    bad(`${procs.length} 'opencode serve' processes are running`);
    info(`only the one that grabbed port ${OPENCODE_PORT} is being probed below.`);
    info(`a stale instance keeps 4096, so a newly started one silently falls back`);
    info(`to a random port -- kill them all and start exactly one:`);
    info(`  pkill -f 'opencode serve' ; pkill -f cloudflared`);
  } else {
    ok(`one 'opencode serve' process`);
  }
}

const listeners = listeningPorts();
const ocListener = listeners.find((l) => l.port === OPENCODE_PORT);
const suspects = listeners.filter(
  (l) => /opencode|bun|node/i.test(l.name) && l.port !== OPENCODE_PORT && l.port !== PLUGIN_PORT && l.port > 1024,
);
if (ocListener) {
  info(`port ${OPENCODE_PORT} held by ${ocListener.name} (pid ${ocListener.pid})`);
}
if (suspects.length) {
  warn(`other node/bun listeners: ${suspects.map((s) => `${s.port} (${s.name})`).join(", ")}`);
  info(`if OpenCode logged a port other than ${OPENCODE_PORT} on startup, then ${OPENCODE_PORT}`);
  info(`was already taken and you are looking at a different, older instance.`);
  info(`re-run with the real port:  OPENCODE_PORT=<that port> node scripts/doctor.mjs`);
}

/* ---------- 4. listeners ---------- */
section("4. local servers");
const oc = await probe(`http://127.0.0.1:${OPENCODE_PORT}/`, { headers: { accept: "text/html" } });
if (oc.error) {
  bad(`nothing answering on 127.0.0.1:${OPENCODE_PORT} (${oc.error})`);
  info(`is 'opencode serve' running?`);
} else {
  ok(`OpenCode answering on ${OPENCODE_PORT} (HTTP ${oc.status})`);
}

const pluginRoot = await probe(`http://127.0.0.1:${PLUGIN_PORT}/`, { headers: { accept: "text/html" } });
const pluginCss = await probe(`http://127.0.0.1:${PLUGIN_PORT}/__oc-mobile/overlay.css`);

if (pluginRoot.error) {
  bad(`nothing answering on 127.0.0.1:${PLUGIN_PORT} (${pluginRoot.error})`);
  if (!oc.error) {
    info(`OpenCode is up but the plugin has not initialised.`);
    info(``);
    info(`  Plugins are INSTANCE-scoped, and 'opencode serve' starts no instance:`);
    info(`  it creates one per request, keyed by the ?directory= query or the`);
    info(`  x-opencode-directory header. So a freshly started server has loaded no`);
    info(`  plugins at all -- nothing on ${PLUGIN_PORT}, no tunnel, and no banner.`);
    info(``);
    info(`  Poke it once to make the plugin load (from a second terminal, leaving`);
    info(`  'opencode serve' running):`);
    info(``);
    info(`    curl -su opencode:"$OPENCODE_SERVER_PASSWORD" \\`);
    info(`      "http://127.0.0.1:${OPENCODE_PORT}/session?directory=$PWD" -o /dev/null -w '%{http_code}\\n'`);
    info(``);
    info(`  Then watch the serve output for '[opencode-mobile] v...' and re-run this.`);
  } else {
    info(`the plugin never started. Most common causes:`);
    info(`  - not started with the 'serve' subcommand (plain 'opencode' and`);
    info(`    'opencode attach' deliberately skip the server and tunnel)`);
    info(`  - the plugin is not registered (see section 1)`);
    info(`  - look for '[opencode-mobile] v...' in the opencode serve output`);
  }
} else {
  ok(`plugin answering on ${PLUGIN_PORT} (HTTP ${pluginRoot.status})`);

  if (pluginCss.error || pluginCss.status !== 200) {
    bad(`plugin is not serving /__oc-mobile/overlay.css (${pluginCss.error ?? "HTTP " + pluginCss.status})`);
    info(`something is on port ${PLUGIN_PORT}, but it is not this build`);
  } else {
    ok(`overlay stylesheet served (${pluginCss.body.length} bytes)`);
  }

  const injected = typeof pluginRoot.body === "string" && pluginRoot.body.includes("oc-mobile-overlay");
  if (injected) ok(`plugin injects the overlay into HTML`);
  else {
    bad(`plugin served HTML without the overlay link`);
    const ct = pluginRoot.headers?.get?.("content-type") ?? "?";
    info(`content-type was: ${ct}`);
    if (process.env.OPENCODE_MOBILE_OVERLAY) {
      info(`OPENCODE_MOBILE_OVERLAY=${process.env.OPENCODE_MOBILE_OVERLAY} in this shell -- 0/false/off disables injection`);
    }
  }
}

/* ---------- 5. where the tunnel points ---------- */
section("5. tunnel");
const meta = readJson(join(configDir, "tunnel.json"));
if (!meta || !meta.url) {
  warn(`no tunnel recorded in ${join(configDir, "tunnel.json")}`);
} else {
  info(`url:        ${meta.url}`);
  info(`provider:   ${meta.provider}`);
  info(`targetPort: ${meta.targetPort}`);
  if (meta.targetPort === PLUGIN_PORT) {
    ok(`tunnel points at the plugin (${PLUGIN_PORT})`);
  } else if (meta.targetPort === OPENCODE_PORT) {
    bad(`tunnel points straight at OpenCode (${OPENCODE_PORT}), bypassing the plugin`);
    info(`this is what the old code did. Either the running plugin is an older`);
    info(`build, or this metadata is stale from a previous run.`);
  } else {
    warn(`tunnel targets port ${meta.targetPort}, which is neither OpenCode nor the plugin`);
  }
}

const saved = readJson(join(homedir(), ".config", "opencode-mobile", "tunnel-config.json"));
if (saved) {
  info(`saved provider config: mode=${saved.mode ?? "free"}${saved.domain ? ` domain=${saved.domain}` : ""}`);
  if (saved.mode === "custom" && saved.domain) {
    warn(`a named tunnel with a custom domain is configured`);
    info(`if you also run cloudflared yourself, or via a systemd service, that`);
    info(`tunnel's own config decides which port it forwards to -- the plugin`);
    info(`cannot move it. Point it at ${PLUGIN_PORT} instead of ${OPENCODE_PORT}.`);
  }
}

try {
  const ps = execSync("ps -eo args= 2>/dev/null | grep -i cloudflared | grep -v grep", {
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
  if (ps) {
    info(`running cloudflared processes:`);
    for (const line of ps.split("\n")) info(`  ${line.slice(0, 160)}`);
    if (/localhost:4096|127\.0\.0\.1:4096|:4096/.test(ps) && !/4097/.test(ps)) {
      bad(`a cloudflared process is forwarding to ${OPENCODE_PORT} -- it bypasses the plugin`);
      info(`if you started it yourself (or it is a service), repoint it at ${PLUGIN_PORT}`);
    }
  }
} catch {
  /* ps unavailable or no matches */
}

/* ---------- 6. the public URL ---------- */
if (meta?.url) {
  section("6. public tunnel URL");
  const pub = await probe(meta.url, { timeout: 10000, headers: { accept: "text/html" } });
  if (pub.error) {
    warn(`could not reach ${meta.url} (${pub.error})`);
    info(`a free trycloudflare URL changes every restart -- this one may be dead`);
  } else if (pub.status === 401) {
    ok(`reachable, asking for the password (HTTP 401) -- expected with OPENCODE_SERVER_PASSWORD set`);
    info(`cannot check injection without credentials; check from the phone instead`);
  } else if (pub.status >= 300 && pub.status < 400) {
    warn(`HTTP ${pub.status} redirect to ${pub.headers?.get?.("location") ?? "?"}`);
  } else if (typeof pub.body === "string" && pub.body.includes("oc-mobile-overlay")) {
    ok(`public URL serves HTML with the overlay injected`);
  } else if (pub.status >= 500) {
    bad(`HTTP ${pub.status} from ${meta.url}`);
    if (pub.status === 530) {
      info(`530 is Cloudflare's "tunnel has no origin" error -- cloudflared is not`);
      info(`running, or is not reachable. That HTML is Cloudflare's error page, not`);
      info(`your app. Start the tunnel (restart 'opencode serve').`);
    }
  } else {
    bad(`HTTP ${pub.status}: served HTML WITHOUT the overlay`);
    info(`the tunnel is not going through the plugin`);
  }
}

/* ---------- summary ---------- */
section(problems ? `${problems} problem(s) found above.` : "No problems found.");
if (!problems) {
  console.log(`  If the phone still looks unchanged:`);
  console.log(`   - you may be on a stale URL. A free trycloudflare URL changes on every`);
  console.log(`     restart; re-scan the QR or re-add to the Home Screen.`);
  console.log(`   - a Home Screen PWA caches aggressively. Open the URL in a normal Safari`);
  console.log(`     tab first to confirm, then re-add.`);
  console.log(`   - the overlay only applies at 767px and below. On a wide window, set`);
  console.log(`     OPENCODE_MOBILE_OVERLAY_MAX_WIDTH=1024 and restart.`);
}
process.exit(problems ? 1 : 0);
