#!/usr/bin/env node
/**
 * `npm run latency` -- how much delay does the proxy itself add?
 *
 * Why this exists
 * ---------------
 * "It lags" has three possible owners: the app, the tunnel, or this plugin.
 * Only one of them is ours, and it is the only one that can be measured from
 * here -- so measure it, rather than tuning a proxy on a hunch and asking
 * someone to re-test on a phone.
 *
 * A fake upstream stands in for OpenCode: an SSE stream stamping each event
 * with the moment it was written, and a POST endpoint that answers at once.
 * Each is then driven twice -- straight at the upstream, and through the real
 * forwardRequest -- and the difference between the two is the proxy's cost.
 *
 * What this cannot see: Cloudflare, cloudflared, the phone's radio, and
 * whatever the client app does between receiving an event and drawing it.
 * Those are the rest of the chain. Knowing the proxy's share is what tells you
 * whether to keep looking here.
 */

import * as http from "http";
import * as https from "https";
import * as path from "path";
import { fileURLToPath } from "url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { forwardRequest } = await import(path.join(root, "dist/src/proxy/forward.js"));

const EVENTS = Number(process.env.LATENCY_EVENTS || 40);
const EVERY_MS = Number(process.env.LATENCY_INTERVAL || 50);
const POSTS = Number(process.env.LATENCY_POSTS || 60);

function percentile(values, p) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[index];
}

function report(label, values) {
  const mean = values.reduce((a, b) => a + b, 0) / (values.length || 1);
  return {
    label,
    n: values.length,
    p50: percentile(values, 50),
    p95: percentile(values, 95),
    max: Math.max(...values, 0),
    mean,
  };
}

/** Stands in for OpenCode: an event stream, and a reply endpoint. */
const upstream = http.createServer((req, res) => {
  if ((req.url || "").startsWith("/event")) {
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    let sent = 0;
    const timer = setInterval(() => {
      if (sent >= EVENTS) {
        clearInterval(timer);
        res.end();
        return;
      }
      sent++;
      // The moment the byte was written, so the reader can subtract.
      res.write(`data: ${JSON.stringify({ type: "question.asked", at: Date.now() })}\n\n`);
    }, EVERY_MS);
    res.on("close", () => clearInterval(timer));
    return;
  }

  // Everything else: read the body and answer immediately, like a reply POST.
  const chunks = [];
  req.on("data", (chunk) => chunks.push(chunk));
  req.on("end", () => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, at: Date.now() }));
  });
});

const proxy = http.createServer((req, res) => {
  forwardRequest(req, res, {
    targetPort: upstream.address().port,
    // The overlay is not in the picture for a native client: it only rewrites
    // text/html, and this measures the paths a JSON client uses.
    overlay: null,
    cssPath: "/__oc-mobile/overlay.css",
    jsPath: "/__oc-mobile/overlay.js",
  });
});

await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
await new Promise((resolve) => proxy.listen(0, "127.0.0.1", resolve));

const upstreamPort = upstream.address().port;
const proxyPort = proxy.address().port;

/** Read the stream and record, per event, write-to-read delay. */
function streamLatencies(port) {
  return new Promise((resolve, reject) => {
    const seen = [];
    const req = http.request(
      { host: "127.0.0.1", port, path: "/event", headers: { accept: "text/event-stream" } },
      (res) => {
        let buffer = "";
        res.setEncoding("utf-8");
        res.on("data", (chunk) => {
          const arrivedAt = Date.now();
          buffer += chunk;
          let index;
          while ((index = buffer.indexOf("\n\n")) !== -1) {
            const frame = buffer.slice(0, index);
            buffer = buffer.slice(index + 2);
            const line = frame.split("\n").find((l) => l.startsWith("data: "));
            if (!line) continue;
            try {
              const { at } = JSON.parse(line.slice(6));
              seen.push(arrivedAt - at);
            } catch {
              /* partial frame */
            }
          }
        });
        res.on("end", () => resolve(seen));
        res.on("error", reject);
      },
    );
    req.on("error", reject);
    req.end();
  });
}

function postOnce(port) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const body = JSON.stringify({ answers: [["Soft-delete, keep data"]] });
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        path: "/question/que_1/reply",
        method: "POST",
        headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body) },
      },
      (res) => {
        res.resume();
        res.on("end", () => resolve(Date.now() - started));
      },
    );
    req.on("error", reject);
    req.end(body);
  });
}

async function postLatencies(port) {
  const out = [];
  for (let i = 0; i < POSTS; i++) out.push(await postOnce(port));
  return out;
}

/**
 * The other half of the question: where in the chain does the time go?
 *
 * The loopback numbers below say what this proxy costs. They can say nothing
 * about OpenCode itself, cloudflared, Cloudflare or the radio -- and that is
 * where the time goes if the proxy is fast and the phone still feels slow.
 *
 * So probe the chain a leg at a time, innermost first:
 *
 *   OpenCode        127.0.0.1:<OPENCODE_PORT>    the agent's own server
 *   plugin          127.0.0.1:<+1>               this reverse proxy in front of it
 *   tunnel          LATENCY_URL                  ...through Cloudflare
 *
 * Each leg contains the ones before it, so the difference between two adjacent
 * legs is what the outer one costs. A leg that fails tells you more than a leg
 * that is slow, which is why the status code is reported first and the timings
 * are withheld unless the request actually succeeded: a 530 answered in 50ms is
 * Cloudflare saying it could not reach your origin, and printing "50ms" next to
 * it invites reading a broken path as a fast one.
 */
const STATUS_MEANING = {
  401: "authentication required -- export OPENCODE_SERVER_PASSWORD in this shell",
  403: "forbidden -- an edge policy (Cloudflare Access?) is refusing a non-browser client",
  404: "no such route -- is this really an OpenCode server?",
  502: "bad gateway -- the plugin could not reach OpenCode",
  530: "Cloudflare could not reach your origin: the tunnel is down, or the plugin " +
    "never started it (`opencode serve` loads no plugins until a request arrives -- use `npm run serve`)",
};

/**
 * One keep-alive agent per leg.
 *
 * Without this every probe pays a fresh TCP (and TLS) handshake, and the
 * plugin leg pays two -- client to plugin, plugin to OpenCode -- which showed
 * up as the plugin "adding 9ms" when the loopback measurement of the same code
 * says 0ms. A real client holds its connection open, so measuring per-request
 * handshakes measures something nobody experiences. The first request still
 * pays it; the rest are what a warm client sees.
 */
const agents = new Map();

function probeClient(base) {
  const target = new URL(base);
  const client = target.protocol === "https:" ? https : http;
  if (!agents.has(base)) {
    const Agent = target.protocol === "https:" ? https.Agent : http.Agent;
    agents.set(base, new Agent({ keepAlive: true, maxSockets: 4 }));
  }
  return { target, client, agent: agents.get(base) };
}

function authHeaders(password) {
  if (!password) return {};
  const user = process.env.OPENCODE_SERVER_USERNAME || "opencode";
  return { authorization: "Basic " + Buffer.from(user + ":" + password).toString("base64") };
}

function getOnce(base, pathname, password) {
  const { target, client, agent } = probeClient(base);
  return new Promise((resolve) => {
    const started = Date.now();
    const request = client.request(
      {
        host: target.hostname,
        port: target.port || undefined,
        path: pathname,
        method: "GET",
        agent,
        headers: { accept: "application/json", ...authHeaders(password) },
      },
      (res) => {
        res.resume();
        res.on("end", () => resolve({ status: res.statusCode, ms: Date.now() - started }));
      },
    );
    request.on("error", (error) => resolve({ error: error.message }));
    request.setTimeout(15000, () => request.destroy(new Error("timed out after 15s")));
    request.end();
  });
}

/**
 * Time to the first byte on the event stream -- the number a question waits on.
 *
 * Deliberately NOT on the pooled agent: this request holds its socket open for
 * as long as the stream lives, so lending it a pooled one would starve the
 * GETs. And sampled more than once, because a single measurement of this was
 * how the plugin came out "faster than OpenCode" -- noise, read as a result.
 */
function firstEvent(base, password) {
  const { target, client } = probeClient(base);
  return new Promise((resolve) => {
    const started = Date.now();
    let settled = false;
    const done = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const request = client.request(
      {
        host: target.hostname,
        port: target.port || undefined,
        path: "/event",
        method: "GET",
        headers: { accept: "text/event-stream", ...authHeaders(password) },
      },
      (res) => {
        res.on("data", () => {
          done({ status: res.statusCode, ms: Date.now() - started });
          request.destroy();
        });
        res.on("end", () => done({ status: res.statusCode, ms: null }));
      },
    );
    request.on("error", (error) => done({ error: error.message }));
    request.setTimeout(20000, () => request.destroy(new Error("timed out after 20s")));
    request.end();
  });
}

async function probeLeg(label, base, password) {
  const gets = [];
  let status = null;
  let failure = null;
  for (let i = 0; i < 12; i++) {
    const result = await getOnce(base, "/session", password);
    if (result.error) {
      failure = result.error;
      break;
    }
    status = result.status;
    gets.push(result.ms);
  }
  if (failure) return { label, base, gets, status, failure, stream: null, streams: [] };
  const streams = [];
  for (let i = 0; i < 3; i++) streams.push(await firstEvent(base, password));
  const timed = streams.filter((s) => !s.error && s.ms !== null).map((s) => s.ms);
  const stream = streams.find((s) => s.error) ?? streams[streams.length - 1];
  return {
    label,
    base,
    gets,
    status,
    failure,
    stream: stream && timed.length ? { ...stream, ms: percentile(timed, 50), samples: timed } : stream,
    streams,
  };
}

function printLeg(leg) {
  console.log(`${leg.label.padEnd(9)} ${leg.base}`);
  if (leg.failure) {
    console.log(`          unreachable: ${leg.failure}`);
    return false;
  }
  const ok = leg.status !== null && leg.status >= 200 && leg.status < 300;
  if (!ok) {
    // Deliberately no timings. A fast error is not a fast path.
    console.log(`          HTTP ${leg.status} on GET /session -- ${STATUS_MEANING[leg.status] ?? "not a success"}`);
    console.log(`          timings withheld: nothing here measured a working request`);
    return false;
  }
  const r = report(leg.label, leg.gets);
  console.log(`          GET /session  p50 ${r.p50}ms  p95 ${r.p95}ms  max ${r.max}ms  (n=${r.n})`);
  const s = leg.stream;
  if (!s || s.error) {
    console.log(`          /event        unreachable${s?.error ? `: ${s.error}` : ""}`);
    return false;
  }
  const streamOk = s.status >= 200 && s.status < 300;
  if (!streamOk) {
    console.log(`          /event        HTTP ${s.status} -- ${STATUS_MEANING[s.status] ?? "not a success"}`);
    return false;
  }
  if (s.ms === null) {
    console.log("          /event        connected, but no event arrived before the stream closed");
    return true;
  }
  const samples = s.samples ? ` (of ${s.samples.map((v) => `${v}ms`).join(", ")})` : "";
  console.log(`          /event        first byte, median ${s.ms}ms${samples}`);
  return true;
}

const openCodePort = Number(process.env.OPENCODE_PORT) || 4096;
const password = process.env.OPENCODE_SERVER_PASSWORD;
const legs = [
  ["OpenCode", `http://127.0.0.1:${openCodePort}`],
  ["plugin", `http://127.0.0.1:${openCodePort + 1}`],
];
if (process.env.LATENCY_URL) legs.push(["tunnel", process.env.LATENCY_URL]);

console.log("the chain, innermost leg first. each leg contains the ones above it.\n");
let allOk = true;
for (const [label, base] of legs) {
  const leg = await probeLeg(label, base, password);
  if (!printLeg(leg)) allOk = false;
  console.log("");
}
if (!allOk) {
  console.log("At least one leg did not answer a working request, so the numbers above");
  console.log("cannot be read as latency. Fix the failing leg, then re-run.\n");
}

console.log(`upstream on ${upstreamPort}, proxy on ${proxyPort}`);
console.log(`${EVENTS} events every ${EVERY_MS}ms, ${POSTS} sequential POSTs, each measured both ways\n`);

// Interleaved rather than one after the other, so a warm/cold difference in the
// process does not read as a difference between the two paths.
const [directEvents, proxiedEvents] = await Promise.all([
  streamLatencies(upstreamPort),
  streamLatencies(proxyPort),
]);
const directPosts = await postLatencies(upstreamPort);
const proxiedPosts = await postLatencies(proxyPort);

upstream.close();
proxy.close();

const rows = [
  report("SSE event, direct", directEvents),
  report("SSE event, through the proxy", proxiedEvents),
  report("reply POST, direct", directPosts),
  report("reply POST, through the proxy", proxiedPosts),
];

const width = Math.max(...rows.map((r) => r.label.length));
console.log(`${"".padEnd(width)}    n    p50    p95    max   mean`);
for (const r of rows) {
  console.log(
    `${r.label.padEnd(width)}  ${String(r.n).padStart(3)}  ${`${r.p50}ms`.padStart(6)}  ` +
      `${`${r.p95}ms`.padStart(6)}  ${`${r.max}ms`.padStart(6)}  ${r.mean.toFixed(1).padStart(6)}ms`,
  );
}

const eventCost = report("", proxiedEvents).p95 - report("", directEvents).p95;
const postCost = report("", proxiedPosts).p95 - report("", directPosts).p95;
console.log(`\nproxy adds, at p95: ${eventCost}ms per event, ${postCost}ms per reply`);
console.log(
  "Not measured here: Cloudflare, cloudflared, the radio, and the client's own render.\n" +
    "If the numbers above are small, the lag is in one of those, not in this plugin.",
);
