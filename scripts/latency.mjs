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
 * The other half of the question: how much does the rest of the chain add?
 *
 * The loopback numbers below say what the proxy costs. They can say nothing
 * about Cloudflare, cloudflared or the radio -- and that is where the time goes
 * if the proxy is fast and the phone still feels slow. So when a public URL is
 * given, measure the same things through it, which turns "it lags" into a
 * number with an owner.
 *
 *   LATENCY_URL=https://your.tunnel npm run latency
 */
async function measureLive(base, password) {
  const target = new URL(base);
  const client = target.protocol === "https:" ? https : http;
  const user = process.env.OPENCODE_SERVER_USERNAME || "opencode";
  const auth = password
    ? { authorization: "Basic " + Buffer.from(user + ":" + password).toString("base64") }
    : {};

  const get = (pathname) =>
    new Promise((resolve, reject) => {
      const started = Date.now();
      const request = client.request(
        {
          host: target.hostname,
          port: target.port || undefined,
          path: pathname,
          method: "GET",
          headers: { accept: "application/json", ...auth },
        },
        (res) => {
          res.resume();
          res.on("end", () => resolve({ status: res.statusCode, total: Date.now() - started }));
        },
      );
      request.on("error", reject);
      request.setTimeout(15000, () => request.destroy(new Error("timed out")));
      request.end();
    });

  // Time to the first event on the stream: the number that decides whether a
  // question reaches the phone promptly.
  const firstEvent = () =>
    new Promise((resolve, reject) => {
      const started = Date.now();
      let settled = false;
      const request = client.request(
        {
          host: target.hostname,
          port: target.port || undefined,
          path: "/event",
          method: "GET",
          headers: { accept: "text/event-stream", ...auth },
        },
        (res) => {
          res.on("data", () => {
            if (settled) return;
            settled = true;
            resolve({ status: res.statusCode, firstEvent: Date.now() - started });
            request.destroy();
          });
          res.on("end", () => {
            if (!settled) resolve({ status: res.statusCode, firstEvent: null });
          });
        },
      );
      request.on("error", (error) => {
        if (settled) return;
        reject(error);
      });
      request.setTimeout(20000, () => request.destroy(new Error("timed out")));
      request.end();
    });

  const gets = [];
  for (let i = 0; i < 8; i++) gets.push((await get("/session")).total);
  return { gets, stream: await firstEvent() };
}

if (process.env.LATENCY_URL) {
  try {
    const live = await measureLive(process.env.LATENCY_URL, process.env.OPENCODE_SERVER_PASSWORD);
    const r = report("GET /session", live.gets);
    const first = live.stream.firstEvent;
    console.log("through " + process.env.LATENCY_URL);
    console.log("  GET /session   p50 " + r.p50 + "ms  p95 " + r.p95 + "ms  max " + r.max + "ms  (n=" + r.n + ")");
    console.log("  first /event   " + (first === null ? "nothing before the stream closed" : first + "ms") +
      "  (HTTP " + live.stream.status + ")");
    console.log("");
  } catch (error) {
    console.log("through " + process.env.LATENCY_URL + ": " + error.message);
    console.log("(set OPENCODE_SERVER_PASSWORD if the server asks for one)\n");
  }
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
