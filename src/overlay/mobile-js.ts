/**
 * The injected script: a session switcher strip.
 *
 * Served same-origin by the proxy so it satisfies OpenCode's `script-src 'self'`
 * (an inline script would be blocked -- the CSP has no `unsafe-inline` for
 * scripts).
 *
 * It reads three OpenCode endpoints and never writes:
 *   GET /session         -> the session list
 *   GET /session/status  -> busy / idle / retry per session
 *   GET /event           -> SSE, to keep both live
 *
 * Every read is defensive about field names because the plugin is used against
 * a range of OpenCode versions. Anything unrecognised degrades to hiding the
 * strip; nothing here is allowed to throw into the host page.
 *
 * The JS below deliberately avoids template literals and `${`, so it can live
 * inside this module's own template literal without escaping.
 */

import type { OverlayConfig } from "./types";

export function buildOverlayJs(config: OverlayConfig): string {
  return `/* opencode-mobile overlay -- session switcher */
(function () {
  "use strict";

  var MAX_WIDTH = ${config.maxWidth};
  var STRIP_ENABLED = ${config.sessionStrip ? "true" : "false"};
  var STATUS_ENABLED = ${config.statusBar ? "true" : "false"};
  if (typeof window === "undefined" || !window.document) return;
  if (!STRIP_ENABLED && !STATUS_ENABLED) return;

  var REFRESH_MS = 20000;
  var RETRY_BASE_MS = 1000;
  var RETRY_MAX_MS = 30000;

  var mq = window.matchMedia("(max-width: " + MAX_WIDTH + "px)");

  var sessions = [];
  var status = Object.create(null);
  var attention = Object.create(null);
  var errored = Object.create(null);

  var strip = null;
  var statusEl = null;
  var statusTick = null;
  // The live tool for the session on screen: { tool, title, startedAt }.
  var running = null;
  var stream = null;
  var observer = null;
  var refreshTimer = null;
  var retryTimer = null;
  var retryCount = 0;
  var listFailed = false;
  var mounted = false;

  /* ---------- api ---------- */

  function getJson(path) {
    return fetch(path, {
      headers: { accept: "application/json" },
      credentials: "same-origin",
      cache: "no-store"
    }).then(function (res) {
      if (!res.ok) throw new Error("HTTP " + res.status);
      return res.json();
    });
  }

  function firstString() {
    for (var i = 0; i < arguments.length; i++) {
      var value = arguments[i];
      if (typeof value === "string" && value.length > 0) return value;
    }
    return "";
  }

  function normalizeSessions(raw) {
    var list = null;
    if (Array.isArray(raw)) list = raw;
    else if (raw && Array.isArray(raw.sessions)) list = raw.sessions;
    else if (raw && Array.isArray(raw.data)) list = raw.data;
    if (!list) return [];

    var out = [];
    for (var i = 0; i < list.length; i++) {
      var item = list[i];
      if (!item || typeof item !== "object") continue;

      var info = item.info && typeof item.info === "object" ? item.info : item;
      var id = firstString(info.id, info.sessionID, info.sessionId);
      if (!id) continue;

      // Child sessions are sub-agent work. They would triple the strip's
      // length for context you did not ask for, so they stay out -- the same
      // call the plugin makes for notifications.
      var parent = firstString(
        info.parentID, info.parentId, info.parentSessionID, info.parentSessionId
      );
      if (parent) continue;

      var time = info.time && typeof info.time === "object" ? info.time : {};
      if (time.archived) continue;

      var updated = Number(time.updated || time.created || 0);
      out.push({
        id: id,
        title: firstString(info.title, info.sessionTitle) || "Session",
        updated: isFinite(updated) ? updated : 0
      });
    }
    return out;
  }

  function normalizeStatus(raw) {
    var next = Object.create(null);
    if (!raw || typeof raw !== "object") return next;
    var keys = Object.keys(raw);
    for (var i = 0; i < keys.length; i++) {
      var value = raw[keys[i]];
      if (typeof value === "string") next[keys[i]] = value;
      else if (value && typeof value === "object" && typeof value.type === "string") {
        next[keys[i]] = value.type;
      }
    }
    return next;
  }

  /* ---------- state ---------- */

  function stateOf(id) {
    if (attention[id]) return "attention";
    if (errored[id]) return "error";
    var type = status[id];
    if (type === "busy" || type === "retry") return "busy";
    return "idle";
  }

  var RANK = { attention: 0, error: 1, busy: 2, idle: 3 };

  function ordered() {
    var copy = sessions.slice();
    copy.sort(function (a, b) {
      var byState = RANK[stateOf(a.id)] - RANK[stateOf(b.id)];
      if (byState !== 0) return byState;
      if (b.updated !== a.updated) return b.updated - a.updated;
      return a.title.localeCompare(b.title);
    });
    return copy;
  }

  /* ---------- routing ---------- */

  // Rather than reconstruct OpenCode's session URLs (they are version and
  // encoding dependent), take the path we are already on and swap the id.
  // Solid's router intercepts same-origin anchor clicks, so a plain href
  // navigates without a reload.
  function routeParts() {
    var match = /^(.*\\/session)(?:\\/([^\\/?#]*))?$/.exec(window.location.pathname);
    if (!match) return null;
    return { prefix: match[1], current: match[2] || "" };
  }

  /* ---------- dom ---------- */

  function anchorPoint() {
    var turn = document.querySelector('[data-component="session-turn"]');
    if (turn && turn.parentNode) return { parent: turn.parentNode, before: turn };
    var root = document.getElementById("root");
    if (root) return { parent: root, before: root.firstChild };
    return null;
  }

  function buildChip(session, route) {
    var state = stateOf(session.id);
    var isCurrent = !!route && route.current === session.id;

    var node = document.createElement(route ? "a" : "span");
    node.setAttribute("data-oc-chip", "");
    node.setAttribute("data-oc-state", state);
    node.setAttribute("data-oc-current", isCurrent ? "true" : "false");
    if (route) {
      node.setAttribute("href", route.prefix + "/" + session.id + window.location.search);
    }

    var label = state === "attention" ? "needs you"
      : state === "error" ? "failed"
      : state === "busy" ? "working"
      : "idle";
    node.setAttribute("aria-label", session.title + " -- " + label);
    if (isCurrent) node.setAttribute("aria-current", "page");

    var dot = document.createElement("span");
    dot.setAttribute("data-oc-chip-dot", "");
    node.appendChild(dot);

    var text = document.createElement("span");
    text.setAttribute("data-oc-chip-label", "");
    text.textContent = session.title;
    node.appendChild(text);

    return node;
  }

  function render() {
    if (!STRIP_ENABLED || !strip) return;

    if (listFailed || sessions.length < 2) {
      // One session is not a switcher, and a failed list should not leave an
      // empty bar wasting a row of screen.
      strip.hidden = true;
      strip.textContent = "";
      return;
    }

    var route = routeParts();
    var items = ordered();
    var next = document.createDocumentFragment();
    for (var i = 0; i < items.length; i++) next.appendChild(buildChip(items[i], route));

    strip.textContent = "";
    strip.appendChild(next);
    strip.hidden = false;
  }

  /* ---------- status bar ---------- */

  // Insert before the composer dock so it pins with the dock rather than
  // needing fixed-position arithmetic against an unknown composer height.
  function statusAnchor() {
    var dock = document.querySelector(
      '[data-component="session-prompt-dock"],' +
      '[data-component="session-followup-dock"],' +
      '[data-component="dock-prompt"]'
    );
    if (dock && dock.parentNode) return { parent: dock.parentNode, before: dock };
    var turn = document.querySelector('[data-component="session-turn"]');
    if (turn && turn.parentNode) return { parent: turn.parentNode, before: turn.nextSibling };
    return null;
  }

  function mountStatus() {
    if (!STATUS_ENABLED) return;
    if (statusEl && statusEl.isConnected) return;

    var point = statusAnchor();
    if (!point) return;

    if (!statusEl) {
      statusEl = document.createElement("div");
      statusEl.setAttribute("data-oc-status", "");
      statusEl.setAttribute("role", "status");
      statusEl.setAttribute("aria-live", "polite");
      statusEl.hidden = true;

      var dot = document.createElement("span");
      dot.setAttribute("data-oc-status-dot", "");
      var text = document.createElement("span");
      text.setAttribute("data-oc-status-text", "");
      var time = document.createElement("span");
      time.setAttribute("data-oc-status-time", "");
      statusEl.appendChild(dot);
      statusEl.appendChild(text);
      statusEl.appendChild(time);
    }

    point.parent.insertBefore(statusEl, point.before || null);
    renderStatus();
  }

  function unmountStatus() {
    if (statusEl && statusEl.parentNode) statusEl.parentNode.removeChild(statusEl);
  }

  function elapsed(since) {
    if (!since) return "";
    var secs = Math.max(0, Math.floor((Date.now() - since) / 1000));
    var mins = Math.floor(secs / 60);
    var rest = secs % 60;
    return mins + ":" + (rest < 10 ? "0" : "") + rest;
  }

  /** The label for a running tool: prefer the tool's own title. */
  function runningLabel(item) {
    if (!item) return "Working";
    if (item.title && item.title !== item.tool) return item.tool + " \u00b7 " + item.title;
    return item.tool || "Working";
  }

  function renderStatus() {
    if (!statusEl) return;

    var route = routeParts();
    var id = route && route.current;
    if (!id) {
      statusEl.hidden = true;
      return;
    }

    var text = statusEl.querySelector("[data-oc-status-text]");
    var time = statusEl.querySelector("[data-oc-status-time]");

    if (attention[id]) {
      statusEl.setAttribute("data-oc-state", "attention");
      if (text) text.textContent = "Waiting for you to approve";
      if (time) time.textContent = "";
      statusEl.hidden = false;
      return;
    }

    if (errored[id]) {
      statusEl.setAttribute("data-oc-state", "error");
      if (text) text.textContent = "Session failed";
      if (time) time.textContent = "";
      statusEl.hidden = false;
      return;
    }

    var type = status[id];
    if (type !== "busy" && type !== "retry") {
      // Idle sessions get no bar: a permanent "idle" line is just a row of
      // wasted screen on a phone.
      statusEl.hidden = true;
      return;
    }

    statusEl.setAttribute("data-oc-state", "busy");
    var live = running && running.sessionID === id ? running : null;
    if (text) text.textContent = type === "retry" ? "Retrying" : runningLabel(live);
    if (time) time.textContent = live ? elapsed(live.startedAt) : "";
    statusEl.hidden = false;
  }

  function startStatusTick() {
    if (statusTick || !STATUS_ENABLED) return;
    // Only the elapsed counter needs a tick; everything else is event driven.
    statusTick = window.setInterval(function () {
      if (!active() || !statusEl || statusEl.hidden) return;
      var route = routeParts();
      var id = route && route.current;
      if (!id || status[id] !== "busy") return;
      var live = running && running.sessionID === id ? running : null;
      var time = statusEl.querySelector("[data-oc-status-time]");
      if (time && live) time.textContent = elapsed(live.startedAt);
    }, 1000);
  }

  function stopStatusTick() {
    if (!statusTick) return;
    window.clearInterval(statusTick);
    statusTick = null;
  }

  /* ---------- session strip ---------- */

  function mount() {
    if (mounted && strip && strip.isConnected) return;

    var point = anchorPoint();
    if (!point) return;

    if (!strip) {
      strip = document.createElement("nav");
      strip.setAttribute("data-oc-strip", "");
      strip.setAttribute("aria-label", "Sessions");
      strip.hidden = true;
    }

    point.parent.insertBefore(strip, point.before || null);
    mounted = true;
    render();
  }

  function unmount() {
    if (strip && strip.parentNode) strip.parentNode.removeChild(strip);
    mounted = false;
  }

  /* ---------- refresh ---------- */

  function refresh() {
    return Promise.all([
      getJson("/session").then(normalizeSessions, function () { return null; }),
      getJson("/session/status").then(normalizeStatus, function () { return null; })
    ]).then(function (results) {
      if (results[0] === null) {
        // The list endpoint is the one we cannot do without.
        listFailed = true;
      } else {
        listFailed = false;
        sessions = results[0];
      }
      if (results[1] !== null) status = results[1];
      render();
      renderStatus();
    });
  }

  function scheduleRefresh() {
    if (refreshTimer) return;
    refreshTimer = window.setTimeout(function () {
      refreshTimer = null;
      if (active()) refresh();
    }, 400);
  }

  /* ---------- events ---------- */

  function sessionIdOf(payload) {
    if (!payload || typeof payload !== "object") return "";
    var props = payload.properties && typeof payload.properties === "object" ? payload.properties : {};
    var info = props.info && typeof props.info === "object" ? props.info : {};
    return firstString(
      props.sessionID, props.sessionId, payload.sessionID, payload.sessionId,
      info.sessionID, info.id
    );
  }

  function handleEvent(payload) {
    var type = payload && typeof payload.type === "string" ? payload.type : "";
    if (!type) return;
    var id = sessionIdOf(payload);

    // The only event that says WHAT is running, not just that something is.
    if (type === "message.part.updated") {
      var part = (payload.properties || {}).part;
      if (!part || part.type !== "tool") return;
      var state = part.state || {};
      if (state.status === "running" || state.status === "pending") {
        running = {
          sessionID: id,
          tool: String(part.tool || ""),
          title: typeof state.title === "string" ? state.title : "",
          startedAt: Number((state.time || {}).start) || Date.now()
        };
      } else if (running && running.sessionID === id && part.tool === running.tool) {
        // The tool we were reporting finished; drop it rather than leaving a
        // stale label and a counter that keeps climbing.
        running = null;
      }
      renderStatus();
      return;
    }

    if (type === "session.status") {
      if (!id) return;
      var props = payload.properties || {};
      var raw = props.status;
      var next = typeof raw === "string" ? raw : (raw && raw.type);
      if (typeof next === "string") status[id] = next;
      if (next === "idle") { delete errored[id]; running = null; }
      render();
      renderStatus();
      return;
    }

    if (type === "session.idle") {
      if (!id) return;
      status[id] = "idle";
      if (running && running.sessionID === id) running = null;
      render();
      renderStatus();
      return;
    }

    if (type === "session.error") {
      if (id) errored[id] = true;
      render();
      renderStatus();
      return;
    }

    if (type === "permission.asked" || type === "permission.v2.asked" || type === "permission.updated") {
      if (id) attention[id] = true;
      render();
      renderStatus();
      return;
    }

    if (type === "permission.replied" || type === "permission.v2.replied") {
      if (id) delete attention[id];
      render();
      renderStatus();
      return;
    }

    if (type === "session.updated" || type === "session.deleted") {
      scheduleRefresh();
    }
  }

  function openStream() {
    if (stream || typeof window.EventSource === "undefined") return;
    try {
      stream = new window.EventSource("/event", { withCredentials: true });
    } catch (err) {
      stream = null;
      return;
    }

    stream.onopen = function () { retryCount = 0; };

    stream.onmessage = function (message) {
      var payload = null;
      try {
        payload = JSON.parse(message.data);
      } catch (err) {
        return;
      }
      try {
        handleEvent(payload);
      } catch (err) {
        /* never let a malformed event break the page */
      }
    };

    stream.onerror = function () {
      closeStream();
      if (!active()) return;
      // Tunnels drop and iOS suspends background tabs; back off rather than
      // hammering on reconnect.
      var delay = Math.min(RETRY_BASE_MS * Math.pow(2, retryCount), RETRY_MAX_MS);
      retryCount++;
      if (retryTimer) window.clearTimeout(retryTimer);
      retryTimer = window.setTimeout(function () {
        retryTimer = null;
        if (active()) { openStream(); refresh(); }
      }, delay);
    };
  }

  function closeStream() {
    if (!stream) return;
    try { stream.close(); } catch (err) { /* already closed */ }
    stream = null;
  }

  /* ---------- lifecycle ---------- */

  function active() {
    return mq.matches;
  }

  function watchDom() {
    if (observer || !window.MutationObserver) return;
    // The app is a SPA: navigating re-renders the timeline and can detach the
    // strip. Re-mount instead of vanishing on the first navigation.
    observer = new window.MutationObserver(function () {
      if (!active()) return;
      if (STRIP_ENABLED) {
        if (!strip || !strip.isConnected) mount();
        else render();
      }
      if (!statusEl || !statusEl.isConnected) mountStatus();
      else renderStatus();
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }

  function stopWatchingDom() {
    if (!observer) return;
    observer.disconnect();
    observer = null;
  }

  var poll = null;

  function start() {
    if (STRIP_ENABLED) mount();
    mountStatus();
    startStatusTick();
    watchDom();
    refresh();
    openStream();
    if (!poll) {
      // Safety net for events that never arrive.
      poll = window.setInterval(function () { if (active()) refresh(); }, REFRESH_MS);
    }
  }

  function stop() {
    stopWatchingDom();
    stopStatusTick();
    closeStream();
    if (poll) { window.clearInterval(poll); poll = null; }
    if (refreshTimer) { window.clearTimeout(refreshTimer); refreshTimer = null; }
    if (retryTimer) { window.clearTimeout(retryTimer); retryTimer = null; }
    unmount();
    unmountStatus();
  }

  function sync() {
    if (active()) start();
    else stop();
  }

  if (typeof mq.addEventListener === "function") mq.addEventListener("change", sync);
  else if (typeof mq.addListener === "function") mq.addListener(sync);

  window.addEventListener("popstate", function () {
    if (!active()) return;
    render();
    renderStatus();
  });

  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState !== "visible" || !active()) return;
    // Coming back from suspend: the stream is usually dead and the state stale.
    if (!stream) openStream();
    refresh();
  });

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", sync, { once: true });
  } else {
    sync();
  }
})();
`;
}
