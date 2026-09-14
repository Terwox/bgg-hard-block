// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Terwox
//
// Firefox-shaped counterpart to tests/background.test.js. It deliberately owns
// a separate mock and runs in its own Node process: the two suites describe
// mutually exclusive browsers (a Chrome build with `initiator`,
// `documentLifecycle`, `pendingUrl` and `extraHeaders`, versus a Gecko build
// with none of them), so a shared mock could only ever describe one of them.
//
// The extension is loaded the way a Gecko event page loads it: `page-bridge.js`
// and then `background.js` are evaluated as classic scripts against one shared
// global, with no `importScripts` defined. That is what `background.scripts` in
// manifest.firefox.json does, and it is why the script order there is
// load-bearing.
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const CONSENT_KEY = "bggHardBlockerConsent";
const OPTIONS_KEY = "bggHardBlockerOptions";
const PROFILE_CACHE_KEY = "bggHardBlockerProfileCache";
const PROFILE_CACHE_SCHEMA_VERSION = 2;
const SUBSCRIPTION_STATE_KEY = "bggHardBlockerSubscriptionState";
const CONTENT_STATE_KEY = "bggHardBlockerState";
const CONTENT_STATE_SCHEMA_VERSION = 3;
const BRIDGE_MESSAGE_TYPE = "bgg-hard-blocker:initialize-bridge:v1";
const STATUS_MESSAGE_TYPE = "bgg-hard-blocker:update-content-status:v1";
const DISCUSSION_URL = "https://boardgamegeek.com/thread/3306128/article/48018767#48018767";
const BGG_ORIGIN = "https://boardgamegeek.com";
// 0.4.7 falls in the current rung of the disclosure ladder in background.js.
const EXTENSION_VERSION = "0.4.7";
const currentConsent = { granted: true, disclosureVersion: "2026-09-03" };
const TOKEN = "GeekAuth test-only-token";

// The Firefox package is identified by the gecko block the packager writes into
// the shipped manifest, so this mock ships the manifest a Gecko build loads.
const FIREFOX_MANIFEST = {
  version: EXTENSION_VERSION,
  browser_specific_settings: {
    gecko: { id: "bgg-hard-block@terwox.github.io", strict_min_version: "153.0" }
  }
};

const listeners = {};
const calls = {
  createdTabs: [], queries: [], reloads: [], scriptExecutions: [], storageSets: [],
  fetches: [], webRequestRegistrations: []
};
let stored = {};
let tabLookup;
let injectionResult;
let fetchHandler;
let documentSequence = 0;

function clone(value) { return value && typeof value === "object" ? structuredClone(value) : value; }
function selectStored(keys, source) {
  const names = Array.isArray(keys) ? keys : [keys];
  return Object.fromEntries(names.filter((name) => Object.hasOwn(source, name))
    .map((name) => [name, clone(source[name])]));
}

globalThis.chrome = {
  runtime: {
    id: "a".repeat(32), getManifest: () => clone(FIREFOX_MANIFEST),
    getURL: (relative) => `moz-extension://test/${relative}`,
    onMessage: { addListener: (fn) => { listeners.message = fn; } },
    onInstalled: { addListener: (fn) => { listeners.installed = fn; } }
  },
  storage: {
    local: {
      async get(keys) { return selectStored(keys, stored); },
      async set(value) { calls.storageSets.push(clone(value)); Object.assign(stored, clone(value)); },
      async remove(keys) {
        for (const name of Array.isArray(keys) ? keys : [keys]) delete stored[name];
      }
    },
    onChanged: { addListener: (fn) => { listeners.storageChanged = fn; } }
  },
  tabs: {
    onUpdated: { addListener: (fn) => { listeners.tabUpdated = fn; } },
    onRemoved: { addListener: (fn) => { listeners.tabRemoved = fn; } },
    async create(options) { calls.createdTabs.push(clone(options)); },
    // Firefox never reports `pendingUrl`; `status` is the only navigation hint.
    async get(tabId) {
      return tabLookup ? clone(await tabLookup(tabId))
        : { id: tabId, url: DISCUSSION_URL, status: "complete" };
    },
    async query(options) { calls.queries.push(clone(options)); return []; },
    async reload(tabId, options) { calls.reloads.push({ tabId, options: clone(options) }); }
  },
  scripting: {
    async insertCSS() {},
    async removeCSS() {},
    async executeScript(options) {
      calls.scriptExecutions.push(options);
      if (options.func === globalThis.installBggBlockListBridge) {
        return typeof injectionResult === "function" ? injectionResult(options) : clone(injectionResult);
      }
      if (options.func?.name === "installNativeMutationRevocationRelay" ||
          options.func?.name === "confirmContentStatusDocument") {
        return [{ frameId: 0, documentId: options.target.documentIds?.[0],
          result: options.func.name === "confirmContentStatusDocument" ? true : null }];
      }
      return [];
    }
  },
  webRequest: {
    // Gecko exposes no EXTRA_HEADERS member, and this mock goes further by not
    // exposing the enum namespace at all, so the probe has nothing to read. A
    // spec that still asked for "extraHeaders" would throw here the way Gecko's
    // schema validator does.
    onBeforeSendHeaders: {
      addListener(fn, filter, extraInfoSpec) {
        if (Array.isArray(extraInfoSpec) && extraInfoSpec.includes("extraHeaders")) {
          throw new Error("Type error for parameter extraInfoSpec: Invalid enumeration value");
        }
        listeners.beforeSendHeaders = fn;
        calls.webRequestRegistrations.push({ filter: clone(filter), extraInfoSpec: clone(extraInfoSpec) });
      }
    }
  }
};

globalThis.fetch = async (url, options) => {
  calls.fetches.push({ url: String(url), method: options.method, headers: clone(options.headers) });
  return fetchHandler(String(url), options);
};

// An event page shares one global across its background scripts, so
// page-bridge.js must run first for `installBggBlockListBridge` to exist by the
// time background.js injects it. `vm.runInThisContext` reproduces that: classic
// script evaluation against the existing global, with no module wrapper and no
// `importScripts` in scope.
for (const file of ["page-bridge.js", "background.js"]) {
  const source = path.join(__dirname, "..", "src", file);
  vm.runInThisContext(fs.readFileSync(source, "utf8"), { filename: source });
}

function jsonResponse(value) {
  return new Response(JSON.stringify(value), {
    status: 200, headers: { "content-type": "application/json" }
  });
}
function versionedProfileCache(profiles = {}) {
  return { schemaVersion: PROFILE_CACHE_SCHEMA_VERSION, profiles };
}
function defaultStored(overrides = {}) {
  return {
    [CONSENT_KEY]: currentConsent,
    [OPTIONS_KEY]: { linkSubscriptionBlocks: true },
    [PROFILE_CACHE_KEY]: versionedProfileCache(),
    ...overrides
  };
}
// A Gecko sender: no `documentLifecycle` at any lifecycle stage, but the
// document identity Firefox 153+ does provide.
function firefoxSender(overrides = {}) {
  documentSequence += 1;
  return {
    id: chrome.runtime.id, tab: { id: 19 }, frameId: 0,
    documentId: `document-${documentSequence}`,
    origin: BGG_ORIGIN, url: DISCUSSION_URL,
    ...overrides
  };
}
function bridgeMessage(overrides = {}) {
  return { type: BRIDGE_MESSAGE_TYPE, channelNonce: "b".repeat(32), ...overrides };
}
// A Gecko request: `originUrl`/`documentUrl` full URLs, never `initiator`.
function firefoxRequestDetails(sender, overrides = {}) {
  return {
    url: "https://api.geekdo.com/api/thread/3477322",
    originUrl: DISCUSSION_URL,
    documentUrl: DISCUSSION_URL,
    tabId: sender.tab.id,
    frameId: 0,
    documentId: sender.documentId,
    type: "xmlhttprequest",
    requestHeaders: [{ name: "Authorization", value: TOKEN }],
    ...overrides
  };
}

function defaultFetch(url, options) {
  const parsed = new URL(url);
  if (parsed.pathname === "/api/userblock") return jsonResponse({ userIds: ["1"] });
  if (parsed.pathname === "/api/user/1") return jsonResponse({ username: "Alice" });
  if (parsed.pathname === "/api/blocks") return jsonResponse({ feeds: [], links: [] });
  if (options.method === "PUT") return new Response(null, { status: 204 });
  throw new Error(`Unexpected test URL: ${url}`);
}

function reset() {
  for (const [name, values] of Object.entries(calls)) {
    // The load-time webRequest registration cannot be replayed, so it is kept.
    if (name !== "webRequestRegistrations") values.length = 0;
  }
  stored = defaultStored();
  // Gecko builds that expose no permissions API are the default shape here;
  // the revocation tests install one for their own duration.
  delete chrome.permissions;
  tabLookup = undefined;
  fetchHandler = defaultFetch;
  injectionResult = (options) => [{
    frameId: 0, documentId: options.target.documentIds[0],
    result: { status: "ready", authorization: TOKEN }
  }];
}

async function settle() {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}
async function sendBridge(message = bridgeMessage(), sender = firefoxSender()) {
  let resolveResponse;
  const responsePromise = new Promise((resolve) => { resolveResponse = resolve; });
  const listenerReturn = listeners.message(message, sender, resolveResponse);
  return { listenerReturn, response: await responsePromise };
}
async function sendStatus(status, sender, channelNonce = "b".repeat(32)) {
  let resolveResponse;
  const responsePromise = new Promise((resolve) => { resolveResponse = resolve; });
  const listenerReturn = listeners.message(
    { type: STATUS_MESSAGE_TYPE, channelNonce, status }, sender, resolveResponse
  );
  return { listenerReturn, response: listenerReturn ? await responsePromise : undefined };
}
// Fires an observed header, then runs a bridge session that cannot supply an
// authorization of its own. A retained header produces a completed sync; a
// refused one can only produce "sync-failed" with no request ever issued.
async function observedHeaderReaches(details, sender) {
  listeners.beforeSendHeaders(details);
  await settle();
  injectionResult = (options) => [{
    frameId: 0, documentId: options.target.documentIds[0],
    result: { status: "ready", authorization: "" }
  }];
  const outcome = await sendBridge(bridgeMessage(), sender);
  return outcome.response.status === "ready";
}

const tests = [];
function test(name, body) { tests.push({ name, body }); }

test("registers the observer without the Chrome-only extraHeaders spec", () => {
  // Reaching this assertion at all proves the module finished evaluating: a
  // throwing addListener at top level would have aborted the whole script.
  assert.deepEqual(calls.webRequestRegistrations, [{
    filter: { urls: ["https://api.geekdo.com/api/*"], types: ["xmlhttprequest"] },
    extraInfoSpec: ["requestHeaders"]
  }]);
  for (const name of [
    "message", "installed", "storageChanged", "tabUpdated", "tabRemoved", "beforeSendHeaders"
  ]) {
    assert.equal(typeof listeners[name], "function");
  }
});

test("omits extraHeaders when the enum exists without an EXTRA_HEADERS member", () => {
  // The other half of the probe: a Gecko that does publish its extraInfoSpec
  // vocabulary still publishes no EXTRA_HEADERS, so the missing member alone
  // must fail the spec closed. Re-evaluating background.js needs a fresh
  // global, because its top-level `const`s cannot be declared twice in one.
  const specs = [];
  const ignore = { addListener() {} };
  const source = path.join(__dirname, "..", "src", "background.js");
  vm.runInNewContext(fs.readFileSync(source, "utf8"), vm.createContext({
    console, structuredClone, URL, Response,
    chrome: {
      runtime: { id: chrome.runtime.id, getManifest: () => clone(FIREFOX_MANIFEST),
        onMessage: ignore, onInstalled: ignore },
      tabs: { onUpdated: ignore, onRemoved: ignore },
      storage: { onChanged: ignore },
      webRequest: {
        OnBeforeSendHeadersOptions: { REQUEST_HEADERS: "requestHeaders", BLOCKING: "blocking" },
        onBeforeSendHeaders: { addListener(fn, filter, spec) { specs.push(clone(spec)); } }
      }
    }
  }), { filename: source });
  assert.deepEqual(specs, [["requestHeaders"]]);
});

test("page-bridge.js publishes the injected bridge on the shared global", () => {
  // background.js passes this by reference to scripting.executeScript, so an
  // event page that loaded the scripts in the wrong order would inject
  // undefined and every session would fail.
  assert.equal(typeof globalThis.installBggBlockListBridge, "function");
});

test("accepts an observed header from a Firefox-shaped request and tab", async () => {
  const sender = firefoxSender({ tab: { id: 42 }, documentId: "gecko-capture-document" });
  assert.equal(await observedHeaderReaches(firefoxRequestDetails(sender), sender), true);
  assert.ok(calls.fetches.length > 0);
  assert.ok(calls.fetches.every((call) => call.headers.Authorization === TOKEN));
});

test("refuses an observed header whose originUrl is not BGG", async () => {
  const sender = firefoxSender({ tab: { id: 43 }, documentId: "foreign-origin-document" });
  const details = firefoxRequestDetails(sender, { originUrl: "https://evil.example/x" });
  assert.equal(await observedHeaderReaches(details, sender), false);
  assert.equal(calls.fetches.length, 0);
});

test("refuses an observed header with no origin candidate at all", async () => {
  const sender = firefoxSender({ tab: { id: 44 }, documentId: "no-origin-document" });
  const details = firefoxRequestDetails(sender);
  delete details.originUrl;
  delete details.documentUrl;
  assert.equal(await observedHeaderReaches(details, sender), false);
  assert.equal(calls.fetches.length, 0);
});

test("refuses an observed header whose originUrl cannot be parsed", async () => {
  const sender = firefoxSender({ tab: { id: 45 }, documentId: "unparsable-origin-document" });
  const details = firefoxRequestDetails(sender, { originUrl: "not a URL" });
  assert.equal(await observedHeaderReaches(details, sender), false);
  assert.equal(calls.fetches.length, 0);
});

test("accepts a content status from a sender with no documentLifecycle", async () => {
  // validContentStatusSender and its re-injection confirmation both have to
  // tolerate the absent field for the popup to ever show Firefox counts.
  const sender = firefoxSender({ tab: { id: 46 }, documentId: "status-document" });
  stored[CONTENT_STATE_KEY] = {
    schemaVersion: CONTENT_STATE_SCHEMA_VERSION, usernames: ["Alice"], avatarIds: [], status: {}
  };
  const outcome = await sendStatus({
    hiddenPosts: 3, hiddenQuotes: 1, redactedProfileNames: 2,
    updatedAt: new Date().toISOString()
  }, sender);
  assert.equal(outcome.listenerReturn, true);
  assert.deepEqual(outcome.response, { status: "ok" });
  assert.equal(stored[CONTENT_STATE_KEY].status.hiddenPosts, 3);
});

test("accepts a bridge sender with no documentLifecycle", async () => {
  const sender = firefoxSender({ tab: { id: 47 }, documentId: "lifecycle-free-document" });
  const outcome = await sendBridge(bridgeMessage(), sender);
  assert.equal(outcome.response.status, "ready");
  assert.equal(calls.storageSets.some((value) => Object.hasOwn(value, SUBSCRIPTION_STATE_KEY)), true);
});

test("still rejects a Chrome-shaped prerendered sender", async () => {
  // The absent-field allowance must not degrade into "any lifecycle passes":
  // a browser that does report a lifecycle is still held to "active".
  const sender = firefoxSender({ tab: { id: 48 }, documentId: "prerender-document",
    documentLifecycle: "prerender" });
  assert.deepEqual((await sendBridge(bridgeMessage(), sender)).response,
    { status: "error", reason: "invalid-sender" });
  assert.equal(calls.scriptExecutions.length, 0);
});

test("serves a loading Gecko tab whose own document_start load is still running", async () => {
  // Firefox reports `status: "loading"` from navigation start until the load
  // event, so the tab hosting this very document_start session is "loading".
  // Treating that as navigating away would reject every Gecko session; only a
  // pendingUrl (which Gecko never reports) means the tab is leaving.
  const sender = firefoxSender({ tab: { id: 49 }, documentId: "loading-tab-document" });
  tabLookup = async (tabId) => ({ id: tabId, url: sender.url, status: "loading" });
  assert.equal((await sendBridge(bridgeMessage(), sender)).response.status, "ready");
});

test("refuses a bridge session once Firefox site access has been revoked", async () => {
  // about:addons can turn host_permissions off after consent, which stops
  // content-script injection and leaves the extension unable to read BGG.
  const queries = [];
  chrome.permissions = {
    async contains(query) { queries.push(clone(query)); return false; }
  };
  const sender = firefoxSender({ tab: { id: 51 }, documentId: "revoked-host-document" });
  assert.deepEqual((await sendBridge(bridgeMessage(), sender)).response,
    { status: "error", reason: "host-permission-required" });
  // The query has to name exactly what the shipped manifest declares: contains
  // is all-or-nothing, so any other list answers a different question.
  const manifest = JSON.parse(fs.readFileSync(
    path.join(__dirname, "..", "manifest.firefox.json"), "utf8"));
  assert.deepEqual(queries, [{ origins: manifest.host_permissions }]);
  // Refused before anything that needs the revoked access.
  assert.equal(calls.scriptExecutions.length, 0);
  assert.equal(calls.fetches.length, 0);
});

test("syncs unchanged on a build that exposes no permissions API", async () => {
  assert.equal(chrome.permissions, undefined);
  const sender = firefoxSender({ tab: { id: 52 }, documentId: "permissionless-document" });
  assert.equal((await sendBridge(bridgeMessage(), sender)).response.status, "ready");
  assert.ok(calls.fetches.length > 0);
});

(async () => {
  let passed = 0;
  for (const { name, body } of tests) {
    reset();
    try { await body(); passed += 1; }
    catch (error) { error.message = `${name}: ${error.message}`; throw error; }
  }
  console.log(`background (firefox): PASS (${passed} tests)`);
})().catch((error) => { console.error(error); process.exitCode = 1; });
