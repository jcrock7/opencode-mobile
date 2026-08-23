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
  var KEYBOARD_ENABLED = ${config.keyboardViewport ? "true" : "false"};
  var CHANGES_ENABLED = ${config.changesButton ? "true" : "false"};
  var ASK_ENABLED = ${config.askDock ? "true" : "false"};
  var DEBUG = ${config.debug ? "true" : "false"};
  if (typeof window === "undefined" || !window.document) return;

  /* ---------- keyboard viewport ----------
     Installed to the Home Screen, OpenCode sets '#root { height: 100vh }' --
     deliberately, because WebKit excludes the safe-area insets from dvh in an
     installed app. But 100vh is the LAYOUT viewport, and iOS does not shrink
     that when the software keyboard opens: it shrinks only the visual
     viewport, then scrolls the document to bring the focused field into view.

     Two symptoms, one cause. The scroll drags the top of the shell -- and the
     safe-area padding with it -- above the visible area, so the timeline runs
     under the clock. And the shell still believes it is full height, so the
     composer sits adrift of the keyboard instead of resting on it.

     Pinning the shell to visualViewport.height fixes both. There is no CSS
     unit for this on iOS: dvh tracks browser chrome, not the keyboard, and
     env(keyboard-inset-*) needs the VirtualKeyboard API, which WebKit does not
     implement. The viewport meta already asks for interactive-widget=
     resizes-content; iOS ignores it.

     Only in standalone mode. In a browser tab Safari's own toolbar collapses
     on scroll, which moves visualViewport.height for reasons that have nothing
     to do with the keyboard, and pinning to it there would fight the browser. */
  function setupKeyboardViewport() {
    var vv = window.visualViewport;
    if (!vv) return;
    var standalone = window.matchMedia("(display-mode: standalone), (display-mode: fullscreen)");
    var root = document.getElementById("root");
    if (!root) return;
    var appliedHeight = -1;
    var frame = null;

    function clear() {
      appliedHeight = -1;
      root.style.removeProperty("height");
      root.removeAttribute("data-oc-keyboard");
    }

    function apply() {
      frame = null;
      // Only while installed and only on a phone-sized viewport. Anywhere else
      // upstream's own height is right and we must not hold it hostage.
      if (!standalone.matches || !mq.matches) {
        if (appliedHeight !== -1) clear();
        renderDebug();
        return;
      }
      // Undo the document scroll iOS applied to reveal the focused field. Once
      // the shell fits the visible area that scroll is pure damage -- it is
      // what drags the titlebar up under the clock.
      if (window.scrollY !== 0 || vv.offsetTop !== 0) window.scrollTo(0, 0);

      var height = Math.round(vv.height);
      if (!(height > 0)) return;
      // No keyboard: hand the height back to upstream's own rule rather than
      // pinning a pixel value that the next rotation would make wrong.
      if (height >= Math.round(window.innerHeight) - 2) {
        if (appliedHeight !== -1) clear();
        root.removeAttribute("data-oc-keyboard");
        renderDebug();
        return;
      }
      if (height !== appliedHeight) {
        appliedHeight = height;
        // Inline wins: upstream's height is not !important.
        root.style.setProperty("height", height + "px", "important");
      }
      // Marks the shell so the stylesheet can collapse the bottom safe-area
      // inset. iOS does not zero env(safe-area-inset-bottom) when the keyboard
      // opens -- the insets describe the device, not whatever is covering it --
      // so the layout goes on reserving a strip for a home indicator the
      // keyboard is sitting on top of. That strip is the blank band between the
      // composer and the keyboard.
      root.setAttribute("data-oc-keyboard", "open");
      renderDebug();
    }

    /**
     * A live readout of the numbers this whole section turns on.
     *
     * Two rounds of this were diagnosed by measuring a screenshot in pixels,
     * which is slow and gets the wrong answer when two explanations predict a
     * similar gap. With OPENCODE_MOBILE_OVERLAY_DEBUG=1 the phone reports the
     * values instead: whether the keyboard is detected, what the visual
     * viewport measures against the layout viewport, what height got pinned,
     * and what iOS claims the bottom inset is -- measured, because that is the
     * value the layout reserves space for and never zeroes for the keyboard.
     */
    function safeAreaBottom() {
      var probe = document.createElement("div");
      probe.style.cssText =
        "position:fixed;left:-9999px;bottom:0;width:1px;height:env(safe-area-inset-bottom,0px);";
      document.body.appendChild(probe);
      var measured = probe.offsetHeight;
      if (probe.parentNode) probe.parentNode.removeChild(probe);
      return measured;
    }

    function renderDebug() {
      if (!DEBUG) return;
      var el = document.querySelector("[data-oc-kbdebug]");
      if (!el) {
        el = document.createElement("div");
        el.setAttribute("data-oc-kbdebug", "");
        document.body.appendChild(el);
      }
      el.textContent =
        "kb " + (root.getAttribute("data-oc-keyboard") === "open" ? "open" : "closed") +
        " | vv " + Math.round(vv.height) +
        " | inner " + Math.round(window.innerHeight) +
        " | root " + (appliedHeight === -1 ? "auto" : appliedHeight) +
        " | sab " + safeAreaBottom() +
        " | y " + Math.round(window.scrollY) + "/" + Math.round(vv.offsetTop);
    }

    function schedule() {
      if (frame !== null) return;
      // Coalesce: iOS fires resize and scroll together, repeatedly, through
      // the whole keyboard animation.
      frame = window.requestAnimationFrame(apply);
    }

    if (typeof vv.addEventListener === "function") {
      vv.addEventListener("resize", schedule);
      vv.addEventListener("scroll", schedule);
    }
    if (typeof standalone.addEventListener === "function") standalone.addEventListener("change", schedule);
    if (typeof mq.addEventListener === "function") mq.addEventListener("change", schedule);
    // A focus can scroll the document before any viewport event lands.
    window.addEventListener("focusin", schedule, true);
    window.addEventListener("orientationchange", schedule);
    schedule();
  }

  if (!STRIP_ENABLED && !STATUS_ENABLED && !KEYBOARD_ENABLED && !CHANGES_ENABLED && !ASK_ENABLED) return;

  var REFRESH_MS = 20000;
  var RETRY_BASE_MS = 1000;
  var RETRY_MAX_MS = 30000;

  var mq = window.matchMedia("(max-width: " + MAX_WIDTH + "px)");

  var sessions = [];
  var status = Object.create(null);
  // Which sessions are blocked on a person, and on what: "question" or
  // "permission". A live event marks one immediately; the fetch that follows is
  // authoritative, so a request answered elsewhere stops showing even when its
  // reply event never reached us. The two agree in practice because a server
  // adds the request to its pending map before publishing the event.
  var attention = Object.create(null);
  var errored = Object.create(null);
  // childId -> parentId, for every child session the list reported.
  var parentOf = Object.create(null);

  var strip = null;
  var statusEl = null;
  var changesBtn = null;
  var changesWatch = null;
  // What renderChanges last wrote, so it can write nothing when nothing moved.
  var changesSignature = "";
  var askEl = null;
  // The pending requests themselves, not just which sessions have one: the
  // dock has to render the question text and its options.
  var pendingQuestions = [];
  var pendingPermissions = [];
  // Which request the dock is showing, and the answers picked so far.
  var askId = "";
  var askTab = 0;
  var askAnswers = [];
  var askSending = false;
  var askSignature = "";
  var statusTick = null;
  // sessionId -> { tool, title, startedAt } for whatever that session is
  // running right now. Keyed by session rather than held as one global,
  // because a tool starting in a second session used to overwrite the label
  // for the one you were looking at.
  var runningBySession = Object.create(null);
  var stream = null;
  var observer = null;
  var refreshTimer = null;
  var retryTimer = null;
  var retryCount = 0;
  var listFailed = false;
  var mounted = false;
  // Diagnostics, rendered only under OPENCODE_MOBILE_OVERLAY_DEBUG=1. Every
  // gate between "the script is running" and "the bar is on screen" is one of
  // these, and none of them is visible from outside.
  var diagEl = null;
  var diagLast = "";
  var diagListStatus = "-";
  var diagStatusCode = "-";
  var diagStreamState = "init";
  var diagEvents = 0;
  var diagLastEvent = "-";
  var diagPendQ = "-";
  var diagPendP = "-";

  /* ---------- api ---------- */

  /* ---------- API context ----------

     Guessing how to address OpenCode's API from the client is a losing game.
     The server resolves an instance per request from '?directory=' or
     'x-opencode-directory'; on top of that there is a workspace/server proxy
     layer where 'GET /session' is answered locally while '/session/status' is
     forwarded, and the v2 route names a SERVER KEY rather than a directory, so
     there is nothing in the URL to reconstruct any of it from.

     Plain '/session' therefore answered 200 with an empty array: a valid
     request to an instance that knew about nothing. Nothing errors, so it looks
     exactly like having no sessions.

     Rather than guess, mirror the app. It is making the right calls already, so
     tapping its fetch to learn the query string and directory header it uses
     gets the overlay to the same instance by construction -- whatever kind of
     server, workspace or sidecar is behind it. */
  var apiSearch = "";
  var apiDirectory = "";
  var apiLearned = false;

  function headerValue(init, name) {
    if (!init || !init.headers) return "";
    var h = init.headers;
    if (typeof h.get === "function") return h.get(name) || "";
    if (Array.isArray(h)) {
      for (var i = 0; i < h.length; i++) {
        if (h[i] && String(h[i][0]).toLowerCase() === name) return String(h[i][1] || "");
      }
      return "";
    }
    var keys = Object.keys(h);
    for (var j = 0; j < keys.length; j++) {
      if (keys[j].toLowerCase() === name) return String(h[keys[j]] || "");
    }
    return "";
  }

  /** Learn from one of the app's own API calls. */
  function learnApiContext(url, init) {
    if (typeof url !== "string" || url.indexOf("://") !== -1 && url.indexOf(window.location.origin) !== 0) return;
    var path = url.charAt(0) === "/" ? url : url.slice(window.location.origin.length);
    // Only the session endpoints: they are the ones whose instance we need, and
    // matching narrowly keeps an unrelated call from teaching us nonsense.
    if (path.indexOf("/session") !== 0 && path.indexOf("/event") !== 0) return;

    var q = path.indexOf("?");
    var raw = q === -1 ? "" : path.slice(q + 1);
    var dir = headerValue(init, "x-opencode-directory");

    // Keep ONLY the parameters that address an instance. The app's own calls
    // carry plenty besides -- '/session/<id>/message?limit=200&before=<cursor>'
    // is the common one -- and an earlier version of this took the whole query
    // string. It then learned the pagination, appended it to '/session', and
    // got an empty list back: it had taught itself to ask the wrong question,
    // and overwrote a good context to do it.
    var seen = new URLSearchParams(raw);
    var keep = new URLSearchParams();
    var directory = seen.get("directory");
    var workspace = seen.get("workspace");
    if (directory) keep.set("directory", directory);
    if (workspace) keep.set("workspace", workspace);
    var query = keep.toString();
    var search = query ? "?" + query : "";

    // A call that addresses no instance teaches nothing -- and must not be
    // allowed to unlearn what a call that did taught us.
    if (!search && !dir) return;

    var changed = search !== apiSearch || dir !== apiDirectory;
    apiSearch = search;
    apiDirectory = dir;
    if (!changed && apiLearned) return;
    apiLearned = true;
    // Re-ask with the context we just learned, and re-point the stream at it.
    renderDiag();
    if (WANTS_DATA) {
      refresh();
      closeStream();
      openStream();
    }
  }

  function tapFetch() {
    var native = window.fetch;
    if (typeof native !== "function") return;
    window.fetch = function (input, init) {
      try {
        var url = typeof input === "string" ? input : input && input.url;
        learnApiContext(url, init || (input && input.headers ? input : null));
      } catch (err) {
        /* learning is best effort; never disturb the app's own request */
      }
      return native.apply(this, arguments);
    };
  }

  /** A path with whatever addressing the app is using. */
  function apiUrl(path) {
    if (!apiSearch) return path;
    return path + (path.indexOf("?") === -1 ? apiSearch : "&" + apiSearch.slice(1));
  }

  function renderDiag() {
    if (!DEBUG) return;
    var route = routeParts();
    var id = (route && route.current) || "";
    var line =
      "route " + (id ? id.slice(0, 12) : "NONE") +
      " | sess " + sessions.length +
      " | list " + diagListStatus + "/" + diagStatusCode +
      " | sse " + diagStreamState + "/" + diagEvents + " " + diagLastEvent +
      " | st " + (id && status[id] ? status[id] : "-") +
      " | att " + (id && attention[id] ? attention[id] : "-") +
      " | pend q" + diagPendQ + " p" + diagPendP +
      " | bar " + (statusEl ? (statusEl.hidden ? "hidden" : "shown") : "unmounted") +
      " | ctx " + (apiLearned ? (apiSearch || "hdr") : "none");
    if (line === diagLast) return;
    diagLast = line;
    if (!diagEl || !diagEl.isConnected) {
      diagEl = document.createElement("div");
      diagEl.setAttribute("data-oc-diag", "");
      document.body.appendChild(diagEl);
    }
    diagEl.textContent = line;
  }

  function getJson(path) {
    var headers = { accept: "application/json" };
    // Whatever the app is using to address the API, use the same.
    if (apiDirectory) headers["x-opencode-directory"] = apiDirectory;
    return fetch(apiUrl(path), {
      headers: headers,
      credentials: "same-origin",
      cache: "no-store"
    }).then(function (res) {
      if (path === "/session") diagListStatus = String(res.status);
      if (path === "/session/status") diagStatusCode = String(res.status);
      if (!res.ok) throw new Error("HTTP " + res.status);
      return res.json();
    });
  }

  function postJson(path, body) {
    var headers = { accept: "application/json", "content-type": "application/json" };
    if (apiDirectory) headers["x-opencode-directory"] = apiDirectory;
    return fetch(apiUrl(path), {
      method: "POST",
      headers: headers,
      credentials: "same-origin",
      cache: "no-store",
      body: JSON.stringify(body || {})
    }).then(function (res) {
      if (!res.ok) throw new Error("HTTP " + res.status);
      return res;
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
    var nextParents = Object.create(null);
    for (var i = 0; i < list.length; i++) {
      var item = list[i];
      if (!item || typeof item !== "object") continue;

      var info = item.info && typeof item.info === "object" ? item.info : item;
      var id = firstString(info.id, info.sessionID, info.sessionId);
      if (!id) continue;

      // Child sessions are sub-agent work. They stay out of the strip as
      // chips of their own -- on a 390pt screen they would multiply its length
      // for context you did not ask for -- but their parentage is recorded so
      // the work they are doing can be attributed to the parent you are
      // actually looking at.
      var parent = firstString(
        info.parentID, info.parentId, info.parentSessionID, info.parentSessionId
      );
      if (parent) {
        nextParents[id] = parent;
        continue;
      }

      var time = info.time && typeof info.time === "object" ? info.time : {};
      if (time.archived) continue;

      var updated = Number(time.updated || time.created || 0);
      out.push({
        id: id,
        title: firstString(info.title, info.sessionTitle) || "Session",
        updated: isFinite(updated) ? updated : 0
      });
    }
    // Rebuilt wholesale each refresh so a finished sub-agent stops counting.
    parentOf = nextParents;
    return out;
  }

  /* ---------- sub-agents ---------- */

  /** The child sessions of 'id' that are doing something right now. */
  function busyChildren(id) {
    var out = [];
    if (!id) return out;
    var ids = Object.keys(parentOf);
    for (var i = 0; i < ids.length; i++) {
      var child = ids[i];
      if (parentOf[child] !== id) continue;
      var type = status[child];
      if (type === "busy" || type === "retry" || runningBySession[child]) out.push(child);
    }
    return out;
  }

  /**
   * What to report for the session on screen. Its own running tool wins; with
   * none, a sub-agent's tool stands in, flagged so the label can say so. That
   * is the case the status bar used to get wrong: while a sub-agent worked,
   * the parent was busy with no tool of its own, so the bar said only
   * "Working" and the delegated work was invisible.
   */
  function liveFor(id) {
    if (!id) return null;
    var own = runningBySession[id];
    if (own) return own;
    var kids = busyChildren(id);
    for (var i = 0; i < kids.length; i++) {
      var live = runningBySession[kids[i]];
      if (live) {
        return {
          sessionID: live.sessionID,
          tool: live.tool,
          title: live.title,
          startedAt: live.startedAt,
          viaChild: true
        };
      }
    }
    return null;
  }

  /**
   * Pending questions and permission requests, fetched rather than awaited.
   *
   * 'attention' was only ever set from a live event, so anything asked BEFORE
   * the page loaded was invisible -- which is the whole monitoring case. Open
   * the phone an hour after the agent asked something and the overlay showed
   * no sign of it, because the event had come and gone.
   *
   * 'GET /question' and 'GET /permission' both return what is still pending
   * across every session, which is exactly the gap. Upstream's own app does the
   * same on load; the overlay simply never did.
   */
  function normalizePending(raw) {
    var list = null;
    if (Array.isArray(raw)) list = raw;
    else if (raw && Array.isArray(raw.data)) list = raw.data;
    if (!list) return [];
    var out = [];
    for (var i = 0; i < list.length; i++) {
      var item = list[i];
      if (!item || typeof item !== "object") continue;
      var sessionID = firstString(item.sessionID, item.sessionId);
      var id = firstString(item.id, item.requestID, item.requestId);
      if (!sessionID || !id) continue;
      out.push({ id: id, sessionID: sessionID, request: item });
    }
    return out;
  }

  /**
   * Fetch one pending endpoint, recording its HTTP status for the readout.
   *
   * The status is worth as much as the list here. A pending question that is
   * held in another process is indistinguishable from one that does not exist
   * -- both are 200 with an empty array -- and only the code tells that apart
   * from a route that is missing or refusing us.
   */
  function getPending(path, sink) {
    return getJson(path).then(
      function (raw) {
        var list = normalizePending(raw);
        sink(String(200) + ":" + list.length);
        return list;
      },
      function (err) {
        var code = /[0-9]{3}/.exec(String(err && err.message));
        sink((code ? code[0] : "err") + ":-");
        return null;
      }
    );
  }

  function refreshPending() {
    // Each independently: an older server may not have both endpoints, and one
    // missing must not cost us the other.
    return Promise.all([
      getPending("/question", function (v) { diagPendQ = v; }),
      getPending("/permission", function (v) { diagPendP = v; })
    ]).then(function (results) {
      var kinds = ["question", "permission"];
      for (var k = 0; k < results.length; k++) {
        var items = results[k];
        if (items === null) continue;
        if (k === 0) pendingQuestions = items;
        else pendingPermissions = items;
        // Rebuild this kind wholesale so a request answered elsewhere stops
        // showing even if we never saw its reply event.
        var keys = Object.keys(attention);
        for (var j = 0; j < keys.length; j++) {
          if (attention[keys[j]] === kinds[k]) delete attention[keys[j]];
        }
        for (var i = 0; i < items.length; i++) attention[items[i].sessionID] = kinds[k];
      }
      render();
      renderStatus();
      renderAsk();
      renderDiag();
    });
  }

  /**
   * A third, independent signal that a session is blocked on a question.
   *
   * The two we had are the live 'question.asked' event and the pending fetch.
   * The event only reaches a client connected when it fired, and the fetch runs
   * on a 20-second poll -- so one missed event left the bar cold for up to
   * twenty seconds while the agent sat waiting, which is exactly the interval
   * in which you want to know.
   *
   * The question TOOL closes that gap. 'question.ask' blocks inside the tool's
   * execute, so its part stays 'running' for the whole time the session is
   * waiting, and 'message.part.updated' repeats while it does. A running part
   * named "question" is therefore proof of a pending question that needs no
   * network at all, and it keeps arriving -- so a single dropped event cannot
   * cost us the state. Permissions have no equivalent: they come from whichever
   * tool needed one, so there is no name to match.
   *
   * The fetch stays authoritative. This only ever marks; refreshPending is what
   * confirms or retires it, and is what supplies the request body the dock
   * needs.
   */
  var QUESTION_TOOL = "question";
  var probedAt = 0;

  function probePending() {
    var now = Date.now();
    // The part updates constantly while blocked; the fetch does not need to.
    if (now - probedAt < 3000) return;
    probedAt = now;
    refreshPending();
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

    // Delegated work, as a count rather than chips of its own. A sub-agent is
    // transient and there can be several at once, so chips would push the
    // sessions you navigate by off the end of the strip -- but "something is
    // running under here" is exactly what you cannot otherwise tell.
    var kids = busyChildren(session.id).length;
    if (kids > 0) {
      var badge = document.createElement("span");
      badge.setAttribute("data-oc-chip-sub", "");
      badge.textContent = "+" + kids;
      node.appendChild(badge);
      node.setAttribute(
        "aria-label",
        session.title + " -- " + label + ", " + kids + (kids === 1 ? " sub-agent" : " sub-agents")
      );
    }

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
    var body = item.title && item.title !== item.tool
      ? item.tool + " \u00b7 " + item.title
      : (item.tool || "Working");
    // Say when the work is a sub-agent's rather than this session's own, so a
    // tool you did not ask for directly is not mistaken for one you did.
    return item.viaChild ? "sub-agent \u00b7 " + body : body;
  }

  /**
   * Hide the bar and reset its state.
   *
   * The state attribute drives the colour, so leaving the last one on a hidden
   * element means a stale "attention" is what shows for an instant the next
   * time the bar appears for some other reason.
   */
  function hideStatus() {
    if (!statusEl) return;
    statusEl.hidden = true;
    statusEl.setAttribute("data-oc-state", "idle");
    renderDiag();
  }

  function renderStatus() {
    if (!statusEl) return;

    var route = routeParts();
    var id = route && route.current;
    if (!id) {
      hideStatus();
      return;
    }

    var text = statusEl.querySelector("[data-oc-status-text]");
    var time = statusEl.querySelector("[data-oc-status-time]");

    if (attention[id]) {
      statusEl.setAttribute("data-oc-state", "attention");
      if (text) {
        text.textContent = attention[id] === "question"
          ? "Waiting for your answer"
          : "Waiting for you to approve";
      }
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
      hideStatus();
      return;
    }

    renderDiag();
    statusEl.setAttribute("data-oc-state", "busy");
    var live = liveFor(id);
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
      var live = liveFor(id);
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

  /* ---------- changes button ----------

     Upstream switches between the timeline and the diff view with a
     two-segment tab bar above the timeline (session.tsx, mobileTabs). On a
     phone that is a permanent row of chrome spent on an occasional control.
     The stylesheet hides it; this puts the same two actions on one button in
     the titlebar, which is already on screen.

     It drives upstream's own trigger with .click() rather than reimplementing
     the switch. That is not laziness: 'mobileTab' is local component state in
     session.tsx, not a route or a query param, so there is nothing else to
     drive it with -- and clicking the real control leaves the panel, its
     scroll state and its keyboard handling entirely upstream's. */

  var GH_ICON =
    '<svg viewBox="0 0 16 16" width="20" height="20" aria-hidden="true" fill="currentColor">' +
    '<path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38' +
    ' 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53' +
    '.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-2.91-.88-2.91-2.79' +
    ' 0-.85.3-1.55.8-2.1-.08-.2-.35-1 .08-2.08 0 0 .66-.21 2.16.8.63-.18 1.3-.27 1.97-.27.67 0 1.34.09' +
    ' 1.97.27 1.5-1.02 2.16-.8 2.16-.8.43 1.08.16 1.88.08 2.08.5.55.8 1.25.8 2.1 0 1.92-1.13 2.59-2.92' +
    ' 2.79.34.3.62.87.62 1.75 0 1.03-.01 1.85-.01 2.11 0 .21.15.46.55.38A7.995 7.995 0 0 0 16 8c0-4.42-3.58-8-8-8Z"/>' +
    "</svg>";

  var CLOSE_ICON =
    '<svg viewBox="0 0 16 16" width="20" height="20" aria-hidden="true" fill="none"' +
    ' stroke="currentColor" stroke-width="1.75" stroke-linecap="round">' +
    '<path d="M4 4l8 8M12 4l-8 8"/>' +
    "</svg>";

  function tabTrigger(value) {
    return document.querySelector('[data-slot="tabs-trigger"][data-value="' + value + '"]');
  }

  /** Kobalte marks the active trigger both ways; accept either. */
  function tabSelected(el) {
    if (!el) return false;
    return el.getAttribute("aria-selected") === "true" || el.hasAttribute("data-selected");
  }

  function renderChanges() {
    if (!changesBtn) return;
    var changes = tabTrigger("changes");
    if (!changes) {
      // No tab bar on this screen: no session open, or a desktop width where
      // upstream renders the panels side by side instead.
      unmountChanges();
      return;
    }

    var showing = tabSelected(changes);
    var label = /\\d+/.exec(changes.textContent || "");
    // Write nothing when nothing changed. The DOM observer watches body for
    // childList changes, so an unconditional rewrite here is a mutation that
    // wakes the observer, which calls this again.
    var signature = (showing ? "open" : "closed") + "|" + (label ? label[0] : "");
    if (signature === changesSignature) return;
    changesSignature = signature;
    changesBtn.setAttribute("data-oc-changes", showing ? "open" : "closed");
    changesBtn.setAttribute("aria-label", showing ? "Back to the session" : "Show changes");
    changesBtn.setAttribute("aria-pressed", showing ? "true" : "false");
    changesBtn.title = showing ? "Back to the session" : "Show changes";
    changesBtn.innerHTML = showing ? CLOSE_ICON : GH_ICON;

    // The tab label carries the changed-file count when there is one. Reading
    // the digits out of it survives translation, where matching the words
    // would not.
    if (!showing && label) {
      var badge = document.createElement("span");
      badge.setAttribute("data-oc-changes-count", "");
      badge.textContent = label[0];
      changesBtn.appendChild(badge);
    }
  }

  function mountChanges() {
    if (!CHANGES_ENABLED) return;
    if (changesBtn && changesBtn.isConnected) {
      renderChanges();
      return;
    }
    // The app has exactly one <header>: the titlebar.
    var header = document.querySelector("header");
    if (!header || !tabTrigger("changes")) return;

    changesBtn = document.createElement("button");
    changesBtn.type = "button";
    changesBtn.setAttribute("data-oc-changes", "closed");
    changesBtn.addEventListener("click", function (event) {
      event.preventDefault();
      var target = tabSelected(tabTrigger("changes")) ? tabTrigger("session") : tabTrigger("changes");
      if (target) target.click();
      // The trigger updates its own state synchronously, but the panel swap is
      // a Solid transition; re-read on the next tick rather than guessing.
      window.setTimeout(renderChanges, 0);
    });
    header.appendChild(changesBtn);

    // The tab can also change without us -- opening a review comment switches
    // it -- so follow the trigger's own selected state.
    var list = tabTrigger("changes").parentNode;
    if (list && window.MutationObserver) {
      if (changesWatch) changesWatch.disconnect();
      changesWatch = new MutationObserver(renderChanges);
      changesWatch.observe(list.parentNode || list, {
        attributes: true,
        subtree: true,
        attributeFilter: ["aria-selected", "data-selected"]
      });
    }

    renderChanges();
  }

  function unmountChanges() {
    changesSignature = "";
    if (changesWatch) { changesWatch.disconnect(); changesWatch = null; }
    if (changesBtn && changesBtn.parentNode) changesBtn.parentNode.removeChild(changesBtn);
    changesBtn = null;
  }

  /* ---------- the ask dock ----------

     Answering the agent from the phone.

     A question and a permission request are the same shape of problem: the
     agent has stopped and is blocked on a person, and until that person
     answers, nothing moves. The status bar says so, which is worth having, but
     a notification you cannot act on is a notification that makes you go and
     find a laptop.

     Upstream draws its own dock for both, and on this setup it does not reach
     the phone. Rather than keep guessing at someone else's Solid tree, the
     overlay asks the API directly -- it already learned how to address it --
     and renders the request itself. Two POSTs answer either kind:

       POST /question/<id>/reply    { answers: [[label, ...], ...] }
       POST /permission/<id>/reply  { reply: "once" | "always" | "reject" }

     If upstream's dock IS on the page, this renders nothing. Two docks for one
     request is worse than none: the same lesson as the double bubble. */

  function upstreamDock() {
    return document.querySelector(
      '[data-component="session-question-dock"],[data-component="session-permission-dock"]'
    );
  }

  /** Pending requests belonging to 'id' or to one of its sub-agents. */
  function pendingFor(list, id) {
    var out = [];
    if (!id) return out;
    for (var i = 0; i < list.length; i++) {
      var item = list[i];
      if (item.sessionID === id || parentOf[item.sessionID] === id) out.push(item);
    }
    return out;
  }

  /**
   * The one request the dock should show: whatever is blocking the session on
   * screen. Questions first -- a question is always the agent waiting on a
   * decision, where a permission request can sometimes be answered by a rule.
   */
  function askFor() {
    var route = routeParts();
    var id = (route && route.current) || "";
    if (!id) return null;
    var questions = pendingFor(pendingQuestions, id);
    if (questions.length) return { kind: "question", item: questions[0] };
    var permissions = pendingFor(pendingPermissions, id);
    if (permissions.length) return { kind: "permission", item: permissions[0] };
    return null;
  }

  function askQuestions(item) {
    var list = item && item.request && item.request.questions;
    return Array.isArray(list) ? list : [];
  }

  /** Reset the picked answers when the dock moves to a different request. */
  function askReset(id, count) {
    askId = id;
    askTab = 0;
    askAnswers = [];
    for (var i = 0; i < count; i++) askAnswers.push([]);
  }

  function askPicked(label) {
    var current = askAnswers[askTab] || [];
    return current.indexOf(label) !== -1;
  }

  function askPick(label, multiple) {
    var current = askAnswers[askTab] || [];
    if (!multiple) {
      askAnswers[askTab] = [label];
      renderAsk();
      return;
    }
    var at = current.indexOf(label);
    if (at === -1) current.push(label);
    else current.splice(at, 1);
    askAnswers[askTab] = current;
    renderAsk();
  }

  function askDone() {
    askSending = false;
    askId = "";
    askTab = 0;
    askAnswers = [];
    askSignature = "";
    // The reply event may or may not reach us; refetching is what actually
    // proves the request is gone.
    refresh();
  }

  function askFailed(err) {
    askSending = false;
    askSignature = "";
    renderAsk();
    // A failed reply is not a reason to keep a dock that may be stale: the
    // request could have been answered on the desktop a second earlier.
    refreshPending();
  }

  function askSubmit(current) {
    if (askSending) return;
    askSending = true;
    renderAsk();
    var answers = [];
    var questions = askQuestions(current.item);
    for (var i = 0; i < questions.length; i++) answers.push(askAnswers[i] || []);
    postJson("/question/" + encodeURIComponent(current.item.id) + "/reply", { answers: answers })
      .then(askDone, askFailed);
  }

  function askReject(current) {
    if (askSending) return;
    askSending = true;
    renderAsk();
    var path = current.kind === "question"
      ? "/question/" + encodeURIComponent(current.item.id) + "/reject"
      : "/permission/" + encodeURIComponent(current.item.id) + "/reply";
    var body = current.kind === "question" ? {} : { reply: "reject" };
    postJson(path, body).then(askDone, askFailed);
  }

  function askAllow(current, reply) {
    if (askSending) return;
    askSending = true;
    renderAsk();
    postJson("/permission/" + encodeURIComponent(current.item.id) + "/reply", { reply: reply })
      .then(askDone, askFailed);
  }

  function askNext(current) {
    var questions = askQuestions(current.item);
    if (askTab >= questions.length - 1) {
      askSubmit(current);
      return;
    }
    askTab++;
    renderAsk();
  }

  function askBack() {
    if (askTab <= 0) return;
    askTab--;
    renderAsk();
  }

  function esc(text) {
    return String(text === undefined || text === null ? "" : text)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function askQuestionHtml(current) {
    var questions = askQuestions(current.item);
    var question = questions[askTab] || {};
    var options = Array.isArray(question.options) ? question.options : [];
    var multiple = question.multiple === true;
    var last = askTab >= questions.length - 1;

    var head = questions.length > 1
      ? "Question " + (askTab + 1) + " of " + questions.length
      : (typeof question.header === "string" && question.header ? question.header : "Question");

    var html =
      '<div data-oc-ask-head><span data-oc-ask-title>' + esc(head) + "</span>" +
      '<button type="button" data-oc-ask-act="reject" aria-label="Dismiss">' + CLOSE_ICON + "</button></div>" +
      '<div data-oc-ask-body><p data-oc-ask-text>' + esc(question.question) + "</p>" +
      '<div data-oc-ask-options role="' + (multiple ? "group" : "radiogroup") + '">';

    for (var i = 0; i < options.length; i++) {
      var option = options[i] || {};
      var label = typeof option.label === "string" ? option.label : "";
      html +=
        '<button type="button" data-oc-ask-option="' + esc(label) + '"' +
        ' role="' + (multiple ? "checkbox" : "radio") + '"' +
        ' aria-checked="' + (askPicked(label) ? "true" : "false") + '"' +
        ' data-picked="' + (askPicked(label) ? "true" : "false") + '"' +
        (askSending ? " disabled" : "") + ">" +
        "<span data-oc-ask-label>" + esc(label) + "</span>" +
        (option.description ? "<span data-oc-ask-desc>" + esc(option.description) + "</span>" : "") +
        "</button>";
    }

    html += "</div>";
    // Stated rather than hidden: typing a free-text answer is upstream's dock
    // only, and picking an option is not always the same thing as answering.
    if (question.custom !== false) {
      html += '<p data-oc-ask-note>A typed answer needs the desktop; the options work here.</p>';
    }
    html += "</div>";

    var picked = (askAnswers[askTab] || []).length > 0;
    html +=
      "<div data-oc-ask-foot>" +
      (askTab > 0 ? '<button type="button" data-oc-ask-act="back"' + (askSending ? " disabled" : "") + ">Back</button>" : "") +
      '<button type="button" data-oc-ask-act="next" data-oc-ask-primary=""' +
      (askSending || !picked ? " disabled" : "") + ">" +
      (askSending ? "Sending..." : last ? "Submit" : "Next") +
      "</button></div>";
    return html;
  }

  function askPermissionHtml(current) {
    var request = current.item.request || {};
    var patterns = Array.isArray(request.patterns) ? request.patterns : [];
    var title = typeof request.permission === "string" && request.permission ? request.permission : "Permission";

    var html =
      '<div data-oc-ask-head><span data-oc-ask-title>' + esc(title) + "</span>" +
      '<button type="button" data-oc-ask-act="reject" aria-label="Reject">' + CLOSE_ICON + "</button></div>" +
      '<div data-oc-ask-body><p data-oc-ask-text>Allow this?</p>';
    if (patterns.length) {
      html += '<div data-oc-ask-patterns>';
      for (var i = 0; i < patterns.length; i++) {
        html += "<code>" + esc(patterns[i]) + "</code>";
      }
      html += "</div>";
    }
    html += "</div>";

    var off = askSending ? " disabled" : "";
    html +=
      "<div data-oc-ask-foot>" +
      '<button type="button" data-oc-ask-act="reject"' + off + ">Reject</button>" +
      '<button type="button" data-oc-ask-act="always"' + off + ">Always</button>" +
      '<button type="button" data-oc-ask-act="once" data-oc-ask-primary=""' + off + ">" +
      (askSending ? "Sending..." : "Allow once") +
      "</button></div>";
    return html;
  }

  function renderAsk() {
    if (!ASK_ENABLED || !askEl) return;
    var current = askFor();

    if (!current || upstreamDock()) {
      // Both conditions, not just the signature: a successful reply clears the
      // signature before refetching, so keying the early return on the
      // signature alone left the answered request on screen.
      if (askEl.hidden && askSignature === "") return;
      askSignature = "";
      askEl.hidden = true;
      askEl.innerHTML = "";
      askEl.removeAttribute("data-oc-ask-kind");
      return;
    }

    var questions = askQuestions(current.item);
    if (askId !== current.item.id) askReset(current.item.id, questions.length);

    // Idempotent: the DOM observer watches body for childList changes, so an
    // unconditional rewrite here is a mutation that wakes the observer, which
    // calls this again. Everything the markup depends on is in the signature.
    var signature = [
      current.kind,
      current.item.id,
      askTab,
      askSending ? "1" : "0",
      JSON.stringify(askAnswers)
    ].join("|");
    if (signature === askSignature) return;
    askSignature = signature;

    askEl.hidden = false;
    askEl.setAttribute("data-oc-ask-kind", current.kind);
    askEl.innerHTML = current.kind === "question" ? askQuestionHtml(current) : askPermissionHtml(current);
  }

  function mountAsk() {
    if (!ASK_ENABLED) return;
    if (askEl && askEl.isConnected) {
      renderAsk();
      return;
    }
    askEl = document.createElement("div");
    askEl.setAttribute("data-oc-ask", "");
    askEl.hidden = true;
    // One delegated listener, because renderAsk replaces the innerHTML: per
    // button handlers would be discarded on every redraw.
    askEl.addEventListener("click", function (event) {
      var target = event.target && event.target.closest
        ? event.target.closest("[data-oc-ask-act],[data-oc-ask-option]")
        : null;
      if (!target) return;
      event.preventDefault();
      var current = askFor();
      if (!current) return;

      var option = target.getAttribute("data-oc-ask-option");
      if (option !== null) {
        if (askSending) return;
        var question = askQuestions(current.item)[askTab] || {};
        askPick(option, question.multiple === true);
        return;
      }

      var act = target.getAttribute("data-oc-ask-act");
      if (act === "reject") askReject(current);
      else if (act === "always") askAllow(current, "always");
      else if (act === "once") askAllow(current, "once");
      else if (act === "back") askBack();
      else if (act === "next") askNext(current);
    });
    document.body.appendChild(askEl);
    askSignature = "";
    renderAsk();
  }

  function unmountAsk() {
    askSignature = "";
    askId = "";
    askTab = 0;
    askAnswers = [];
    askSending = false;
    if (askEl && askEl.parentNode) askEl.parentNode.removeChild(askEl);
    askEl = null;
  }

  /* ---------- refresh ---------- */

  function refresh() {
    // Pending requests are fetched alongside the list, not instead of it: they
    // answer a different question and either can fail on its own.
    refreshPending();
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
      renderAsk();
      renderDiag();
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
      if (!id) return;
      var running = state.status === "running" || state.status === "pending";
      if (running) {
        runningBySession[id] = {
          sessionID: id,
          tool: String(part.tool || ""),
          title: typeof state.title === "string" ? state.title : "",
          startedAt: Number((state.time || {}).start) || Date.now()
        };
      } else {
        var held = runningBySession[id];
        // The tool we were reporting finished; drop it rather than leaving a
        // stale label and a counter that keeps climbing. Scoped to the session
        // that reported it, so a sub-agent finishing cannot clear its parent's.
        if (held && part.tool === held.tool) delete runningBySession[id];
      }

      // A running "question" tool IS a pending question -- see probePending.
      // Symmetric on the way out: the tool returns as soon as the answer lands,
      // so a finished one retires the mark whether or not we saw the reply.
      if (part.tool === QUESTION_TOOL) {
        if (running) attention[id] = "question";
        else if (attention[id] === "question") delete attention[id];
        probePending();
      }
      // A sub-agent's tool shows on its parent's bar, so a child's event has
      // to redraw even though the child is not the session on screen.
      render();
      renderStatus();
      return;
    }

    if (type === "session.status") {
      if (!id) return;
      var props = payload.properties || {};
      var raw = props.status;
      var next = typeof raw === "string" ? raw : (raw && raw.type);
      if (typeof next === "string") status[id] = next;
      if (next === "idle") { delete errored[id]; delete runningBySession[id]; }
      render();
      renderStatus();
      return;
    }

    if (type === "session.idle") {
      if (!id) return;
      status[id] = "idle";
      delete runningBySession[id];
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

    // Both kinds block the session on a human. The value records which, so the
    // status bar can say what is actually wanted rather than guessing.
    if (type === "permission.asked" || type === "permission.v2.asked" || type === "permission.updated") {
      if (id) attention[id] = "permission";
      render();
      renderStatus();
      // The event says a request exists; it does not carry the request in a
      // shape the dock can rely on across both schema generations. Refetch.
      if (ASK_ENABLED) refreshPending();
      return;
    }

    if (type === "question.asked" || type === "question.v2.asked") {
      if (id) attention[id] = "question";
      render();
      renderStatus();
      if (ASK_ENABLED) refreshPending();
      return;
    }

    if (
      type === "permission.replied" || type === "permission.v2.replied" ||
      type === "question.replied" || type === "question.v2.replied" ||
      type === "question.rejected" || type === "question.v2.rejected"
    ) {
      if (id) delete attention[id];
      render();
      renderStatus();
      // Answered somewhere else: take the dock down rather than leave a
      // request on screen that no longer exists.
      if (ASK_ENABLED) refreshPending();
      return;
    }

    if (type === "session.updated" || type === "session.deleted") {
      scheduleRefresh();
    }
  }

  function openStream() {
    if (stream || typeof window.EventSource === "undefined") return;
    try {
      stream = new window.EventSource(apiUrl("/event"), { withCredentials: true });
    } catch (err) {
      stream = null;
      return;
    }

    stream.onopen = function () { retryCount = 0; diagStreamState = "open"; renderDiag(); };

    stream.onmessage = function (message) {
      var payload = null;
      try {
        payload = JSON.parse(message.data);
      } catch (err) {
        return;
      }
      diagEvents++;
      if (payload && typeof payload.type === "string") diagLastEvent = payload.type;
      try {
        handleEvent(payload);
      } catch (err) {
        /* never let a malformed event break the page */
      }
      renderDiag();
    };

    stream.onerror = function () {
      closeStream();
      diagStreamState = "error";
      renderDiag();
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
      if (!observer) return;
      // Everything below writes to the DOM, and those writes are childList
      // mutations inside document.body -- which is what this observer watches.
      // Left connected, the callback re-enters on its own output and never
      // stops: the main thread pegs and every control on the page goes dead,
      // including all of OpenCode's own. So: detach, do the work, discard the
      // records our own writes queued, reattach.
      observer.disconnect();
      try {
        if (active()) {
          if (STRIP_ENABLED) {
            if (!strip || !strip.isConnected) mount();
            else render();
          }
          if (!statusEl || !statusEl.isConnected) mountStatus();
          else renderStatus();
          // The tab bar appears and disappears with the session route.
          mountChanges();
          if (!askEl || !askEl.isConnected) mountAsk();
          else renderAsk();
        }
      } finally {
        // stopWatchingDom() may have run inside the try.
        if (observer) {
          observer.takeRecords();
          observer.observe(document.body, { childList: true, subtree: true });
        }
      }
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
    mountChanges();
    mountAsk();
    startStatusTick();
    watchDom();
    if (!WANTS_DATA) return;
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
    unmountChanges();
    unmountAsk();
  }

  // The strip and the status bar are the only things that need session data;
  // the changes button reads the DOM only. But it still has to be mounted and
  // unmounted with the breakpoint, so it cannot ride on WANTS_DATA.
  var WANTS_DATA = STRIP_ENABLED || STATUS_ENABLED || ASK_ENABLED;
  var WANTS_DOM = WANTS_DATA || CHANGES_ENABLED;

  function sync() {
    if (!WANTS_DOM) return;
    if (active()) start();
    else stop();
  }

  if (typeof mq.addEventListener === "function") mq.addEventListener("change", sync);
  else if (typeof mq.addListener === "function") mq.addListener(sync);

  window.addEventListener("popstate", function () {
    if (!active()) return;
    render();
    renderStatus();
    // The dock belongs to the session on screen, and the route just changed.
    renderAsk();
  });

  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState !== "visible" || !active()) return;
    // Coming back from suspend: the stream is usually dead and the state stale.
    if (!stream) openStream();
    refresh();
  });

  function boot() {
    // Installed before the first refresh so the app's own early calls are seen.
    try { tapFetch(); } catch (err) { /* never break the host page */ }
    // The keyboard fix is a layout repair, not a feature of the strip, so it
    // runs whatever else is switched off -- and at every width, since it
    // decides for itself when it applies.
    if (KEYBOARD_ENABLED) {
      try { setupKeyboardViewport(); } catch (err) { /* never throw into the host page */ }
    }
    sync();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot, { once: true });
  } else {
    boot();
  }
})();
`;
}
