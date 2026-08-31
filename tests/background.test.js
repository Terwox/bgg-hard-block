// SPDX-License-Identifier: GPL-3.0-or-later
"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");

const CONSENT_KEY = "bggHardBlockerConsent";
const OPTIONS_KEY = "bggHardBlockerOptions";
const PROFILE_CACHE_KEY = "bggHardBlockerProfileCache";
const SUBSCRIPTION_STATE_KEY = "bggHardBlockerSubscriptionState";
const CONTENT_STATE_KEY = "bggHardBlockerState";
const MESSAGE_TYPE = "bgg-hard-blocker:initialize-bridge:v1";
const STATUS_MESSAGE_TYPE = "bgg-hard-blocker:update-content-status:v1";
const MUTATION_MESSAGE_TYPE = "bgg-hard-blocker:native-userblock-mutation:v1";
const currentConsent = { granted: true, disclosureVersion: "2026-08-15" };
const TOKEN = "GeekAuth test-only-token";

const listeners = {};
const calls = {
  createdTabs: [], events: [], queries: [], reloads: [], cssInsertions: [],
  cssRemovals: [], scriptExecutions: [], storageGets: [], storageSets: [],
  storageRemoves: [], fetches: [], webRequestRegistrations: []
};
let stored = {};
let storageGetter;
let storageSetter;
let queriedTabs = [{ id: 7 }, { id: 11 }, { id: undefined }];
let tabLookup;
let injectionResult;
let fetchHandler;
let cssInsertionHandler;
let stopExecutionHandler;
let statusDocumentHandler;
let documentSequence = 0;

globalThis.installBggBlockListBridge = function installBggBlockListBridge() {};

function clone(value) { return value && typeof value === "object" ? structuredClone(value) : value; }
function selectStored(keys, source) {
  const names = Array.isArray(keys) ? keys : [keys];
  return Object.fromEntries(names.filter((name) => Object.hasOwn(source, name))
    .map((name) => [name, clone(source[name])]));
}

globalThis.chrome = {
  runtime: {
    id: "a".repeat(32), getManifest: () => ({ version: "0.4.0" }),
    getURL: (relative) => `chrome-extension://test/${relative}`,
    onMessage: { addListener: (fn) => { listeners.message = fn; } },
    onInstalled: { addListener: (fn) => { listeners.installed = fn; } }
  },
  storage: {
    local: {
      async get(keys) {
        calls.storageGets.push(clone(keys));
        const source = storageGetter ? await storageGetter(keys) : stored;
        return selectStored(keys, source);
      },
      async set(value) {
        calls.storageSets.push(clone(value));
        Object.assign(stored, clone(value));
        if (storageSetter) await storageSetter(value);
      },
      async remove(keys) {
        const names = Array.isArray(keys) ? keys : [keys];
        calls.storageRemoves.push(clone(names));
        for (const name of names) delete stored[name];
        calls.events.push("remove-derived");
      }
    },
    onChanged: { addListener: (fn) => { listeners.storageChanged = fn; } }
  },
  tabs: {
    onUpdated: { addListener: (fn) => { listeners.tabUpdated = fn; } },
    onRemoved: { addListener: (fn) => { listeners.tabRemoved = fn; } },
    async create(options) { calls.createdTabs.push(clone(options)); },
    async get(tabId) {
      return tabLookup ? clone(await tabLookup(tabId))
        : { id: tabId,
          url: "https://boardgamegeek.com/thread/3306128/article/48018767#48018767" };
    },
    async query(options) { calls.queries.push(clone(options)); return clone(queriedTabs); },
    async reload(tabId, options) {
      calls.events.push(`reload:${tabId}`);
      calls.reloads.push({ tabId, options: clone(options) });
    }
  },
  scripting: {
    async insertCSS(options) {
      calls.events.push(`insert-css:${options.target.tabId}`);
      calls.cssInsertions.push(clone(options));
      if (cssInsertionHandler) await cssInsertionHandler(options);
    },
    async removeCSS(options) {
      calls.events.push(`remove-css:${options.target.tabId}`);
      calls.cssRemovals.push(clone(options));
    },
    async executeScript(options) {
      calls.scriptExecutions.push(options);
      if (options.func === globalThis.installBggBlockListBridge) {
        return typeof injectionResult === "function" ? injectionResult(options) : clone(injectionResult);
      }
      if (options.func?.name === "installNativeMutationRevocationRelay") {
        return [{ frameId: 0, documentId: options.target.documentIds?.[0], result: null }];
      }
      if (options.func?.name === "confirmContentStatusDocument") {
        return statusDocumentHandler ? statusDocumentHandler(options) : [{
          frameId: 0, documentId: options.target.documentIds?.[0], result: true
        }];
      }
      if (options.files) {
        calls.events.push(`inject-isolated:${options.target.tabId}`);
      } else {
        calls.events.push(`${options.world === "MAIN" ? "stop" : "deactivate"}:${options.target.tabId}`);
        if (options.world === "MAIN" && stopExecutionHandler) await stopExecutionHandler(options);
      }
      return [];
    }
  },
  webRequest: {
    onBeforeSendHeaders: {
      addListener(fn, filter, extraInfoSpec) {
        listeners.beforeSendHeaders = fn;
        calls.webRequestRegistrations.push({ filter: clone(filter), extraInfoSpec: clone(extraInfoSpec) });
      }
    }
  }
};

globalThis.fetch = async (url, options) => {
  calls.fetches.push({
    url: String(url), method: options.method, headers: clone(options.headers), body: options.body,
    cache: options.cache, credentials: options.credentials, redirect: options.redirect,
    signal: options.signal
  });
  return fetchHandler(String(url), options);
};

require(path.join(__dirname, "..", "src", "background.js"));

function jsonResponse(value, overrides = {}) {
  return new Response(JSON.stringify(value), {
    status: 200, headers: { "content-type": "application/json" }, ...overrides
  });
}
function defaultStored(overrides = {}) {
  return {
    [CONSENT_KEY]: currentConsent,
    [OPTIONS_KEY]: { linkSubscriptionBlocks: true },
    [PROFILE_CACHE_KEY]: {},
    ...overrides
  };
}
function readyResult(overrides = {}) { return { status: "ready", authorization: TOKEN, ...overrides }; }
function validSender(overrides = {}) {
  documentSequence += 1;
  return {
    id: chrome.runtime.id, tab: { id: 19 }, frameId: 0,
    documentId: `document-${documentSequence}`, documentLifecycle: "active",
    origin: "https://boardgamegeek.com",
    url: "https://boardgamegeek.com/thread/3306128/article/48018767#48018767",
    ...overrides
  };
}
function validMessage(overrides = {}) {
  return { type: MESSAGE_TYPE, channelNonce: "b".repeat(32), ...overrides };
}

function defaultFetch(url, options) {
  const parsed = new URL(url);
  if (parsed.pathname === "/api/userblock") return jsonResponse({ userIds: ["1", "2"] });
  if (parsed.pathname === "/api/user/1") return jsonResponse({ username: "Alice" });
  if (parsed.pathname === "/api/user/2") return jsonResponse({ username: "Bob" });
  if (parsed.pathname === "/api/blocks" || parsed.pathname === "/api/blocks/") {
    return jsonResponse({ feeds: [], links: [] });
  }
  if (options.method === "PUT") return new Response(null, { status: 204 });
  throw new Error(`Unexpected test URL: ${url}`);
}

function reset() {
  for (const [name, values] of Object.entries(calls)) {
    if (name !== "webRequestRegistrations") values.length = 0;
  }
  stored = defaultStored();
  storageGetter = undefined;
  storageSetter = undefined;
  queriedTabs = [{ id: 7 }, { id: 11 }, { id: undefined }];
  tabLookup = undefined;
  fetchHandler = defaultFetch;
  cssInsertionHandler = undefined;
  stopExecutionHandler = undefined;
  statusDocumentHandler = undefined;
  injectionResult = (options) => [{
    frameId: 0, documentId: options.target.documentIds[0], result: readyResult()
  }];
}

function bridgeInjections() {
  return calls.scriptExecutions.filter((options) => options.func === globalThis.installBggBlockListBridge);
}
function stopExecutions() {
  return calls.scriptExecutions.filter((options) => options.func &&
    options.func !== globalThis.installBggBlockListBridge &&
    options.func.name !== "installNativeMutationRevocationRelay" &&
    options.func.name !== "confirmContentStatusDocument");
}
function persisted() {
  return calls.storageSets.filter((value) => Object.hasOwn(value, SUBSCRIPTION_STATE_KEY));
}

async function sendBridge(message = validMessage(), sender = validSender()) {
  let callbackCount = 0;
  let synchronous = true;
  let callbackWasSynchronous = false;
  let resolveResponse;
  const responsePromise = new Promise((resolve) => { resolveResponse = resolve; });
  const listenerReturn = listeners.message(message, sender, (response) => {
    callbackCount += 1;
    callbackWasSynchronous = synchronous;
    resolveResponse(response);
  });
  synchronous = false;
  const response = await responsePromise;
  return { listenerReturn, response, callbackCount, callbackWasSynchronous };
}
async function sendStatus(status, sender, channelNonce = "b".repeat(32)) {
  let resolveResponse;
  const responsePromise = new Promise((resolve) => { resolveResponse = resolve; });
  const listenerReturn = listeners.message(
    { type: STATUS_MESSAGE_TYPE, channelNonce, status }, sender, resolveResponse
  );
  return { listenerReturn, response: listenerReturn ? await responsePromise : undefined };
}
async function settle() {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

const tests = [];
function test(name, body) { tests.push({ name, body }); }

test("registers all background event listeners", () => {
  for (const name of [
    "message", "installed", "storageChanged", "tabUpdated", "tabRemoved", "beforeSendHeaders"
  ]) {
    assert.equal(typeof listeners[name], "function");
  }
  assert.deepEqual(calls.webRequestRegistrations, [{
    filter: {
      urls: ["https://api.geekdo.com/api/*"],
      types: ["xmlhttprequest"]
    },
    extraInfoSpec: ["requestHeaders", "extraHeaders"]
  }]);
});

test("uses an exact-document BGG API header when late MAIN-world capture misses", async () => {
  const sender = validSender({ tab: { id: 42 }, documentId: "network-capture-document" });
  injectionResult = () => new Promise(() => {});
  const pending = sendBridge(validMessage(), sender);
  await settle();

  listeners.beforeSendHeaders({
    url: "https://api.geekdo.com/api/thread/3477322",
    initiator: "https://boardgamegeek.com",
    tabId: sender.tab.id,
    frameId: 0,
    documentId: sender.documentId,
    type: "xmlhttprequest",
    requestHeaders: [{ name: "Authorization", value: TOKEN }]
  });
  await settle();

  const outcome = await pending;
  assert.equal(outcome.response.status, "ready");
  assert.ok(calls.fetches.length > 0);
  assert.ok(calls.fetches.every((call) => call.headers.Authorization === TOKEN));
});

test("keeps the capture open when a duplicate MAIN entry reports cancelled", async () => {
  // Chrome runs the injected bridge twice in one document for a single
  // executeScript call. The entry that loses the duplicate resolves as
  // "cancelled" almost immediately, while BGG's first authenticated
  // api.geekdo.com request is several hundred milliseconds later. Measured on
  // boardgamegeek.com/thread/... on 2026-08-31: cancelled at +219ms, first
  // observed GeekAuth header at +809ms. 0.4.2 ended the session on the
  // cancelled result and answered "sync-failed", so nothing was ever synced.
  const sender = validSender({ tab: { id: 46 }, documentId: "duplicate-entry-document" });
  injectionResult = (options) => [{ frameId: 0, documentId: options.target.documentIds[0],
    result: { status: "error", reason: "cancelled" } }];
  const pending = sendBridge(validMessage(), sender);
  await settle();

  listeners.beforeSendHeaders({
    url: "https://api.geekdo.com/api/userblock",
    initiator: "https://boardgamegeek.com",
    tabId: sender.tab.id,
    frameId: 0,
    documentId: sender.documentId,
    type: "xmlhttprequest",
    requestHeaders: [{ name: "Authorization", value: TOKEN }]
  });
  await settle();

  const outcome = await pending;
  assert.equal(outcome.response.status, "ready");
  assert.ok(calls.fetches.every((call) => call.headers.Authorization === TOKEN));
  // Tearing the page bridge down here is what killed the replacement entry.
  assert.deepEqual(stopExecutions(), []);
  assert.equal(persisted().length, 1);
});

test("retains a consent-authorized header observed before the bridge session starts", async () => {
  const sender = validSender({ tab: { id: 44 }, documentId: "cold-worker-document" });
  listeners.beforeSendHeaders({
    url: "https://api.geekdo.com/api/thread/3477322",
    initiator: "https://boardgamegeek.com",
    tabId: sender.tab.id,
    frameId: 0,
    documentId: sender.documentId,
    type: "xmlhttprequest",
    requestHeaders: [{ name: "Authorization", value: TOKEN }]
  });
  await settle();

  injectionResult = () => new Promise(() => {});
  const outcome = await sendBridge(validMessage(), sender);
  assert.equal(outcome.response.status, "ready");
  assert.ok(calls.fetches.length > 0);
  assert.ok(calls.fetches.every((call) => call.headers.Authorization === TOKEN));
});

test("does not inspect or retain an observed header without current consent", async () => {
  const sender = validSender({ tab: { id: 45 }, documentId: "no-consent-network-document" });
  stored = defaultStored({ [CONSENT_KEY]: undefined });
  listeners.beforeSendHeaders({
    url: "https://api.geekdo.com/api/thread/3477322",
    initiator: "https://boardgamegeek.com",
    tabId: sender.tab.id,
    frameId: 0,
    documentId: sender.documentId,
    type: "xmlhttprequest",
    requestHeaders: [{ name: "Authorization", value: TOKEN }]
  });
  await settle();

  stored = defaultStored();
  injectionResult = (options) => [{
    frameId: 0,
    documentId: options.target.documentIds[0],
    result: readyResult({ authorization: "" })
  }];
  const outcome = await sendBridge(validMessage(), sender);
  assert.equal(calls.fetches.length, 0);
  assert.deepEqual(outcome.response, { status: "error", reason: "sync-failed" });
});

test("ignores observed authorization outside the exact BGG document and API origin", async () => {
  const sender = validSender({ tab: { id: 43 }, documentId: "scoped-network-capture" });
  injectionResult = () => new Promise(() => {});
  const pending = sendBridge(validMessage(), sender);
  await settle();

  for (const overrides of [
    { initiator: "https://evil.example" },
    { url: "https://api.geekdo.com.evil.example/api/thread/1" },
    { tabId: 99 },
    { documentId: "other-document" },
    { frameId: 1 },
    { requestHeaders: [{ name: "Authorization", value: "Bearer wrong" }] }
  ]) {
    listeners.beforeSendHeaders({
      url: "https://api.geekdo.com/api/thread/3477322",
      initiator: "https://boardgamegeek.com",
      tabId: sender.tab.id,
      frameId: 0,
      documentId: sender.documentId,
      type: "xmlhttprequest",
      requestHeaders: [{ name: "Authorization", value: TOKEN }],
      ...overrides
    });
  }
  await settle();
  assert.equal(calls.fetches.length, 0);

  listeners.beforeSendHeaders({
    url: "https://api.geekdo.com/api/thread/3477322",
    initiator: "https://boardgamegeek.com",
    tabId: sender.tab.id,
    frameId: 0,
    documentId: sender.documentId,
    type: "xmlhttprequest",
    requestHeaders: [{ name: "authorization", value: TOKEN }]
  });
  await settle();
  assert.equal((await pending).response.status, "ready");
  listeners.tabRemoved(99);
  listeners.tabRemoved(sender.tab.id);
});

test("returns false without responding to unrelated messages", async () => {
  let responded = false;
  assert.equal(listeners.message({ type: "other" }, validSender(), () => { responded = true; }), false);
  await settle();
  assert.equal(responded, false);
});

const invalidSenderCases = [
  ["malformed nonce", () => [validMessage({ channelNonce: "short" }), validSender()]],
  ["another extension", () => [validMessage(), validSender({ id: "c".repeat(32) })]],
  ["noninteger tab", () => [validMessage(), validSender({ tab: { id: "19" } })]],
  ["child frame", () => [validMessage(), validSender({ frameId: 1 })]],
  ["missing document", () => [validMessage(), validSender({ documentId: "" })]],
  ["inactive lifecycle", () => [validMessage(), validSender({ documentLifecycle: "prerender" })]],
  ["wrong origin", () => [validMessage(), validSender({ origin: "https://evil.example" })]],
  ["HTTP URL", () => [validMessage(), validSender({ url: "http://boardgamegeek.com/thread/1" })]],
  ["credentialed URL", () => [validMessage(), validSender({ url: "https://x@boardgamegeek.com/thread/1" })]],
  ["unsupported path", () => [validMessage(), validSender({ url: "https://boardgamegeek.com/boardgame/1" })]],
  ["invalid URL", () => [validMessage(), validSender({ url: "not a URL" })]]
];
for (const [label, make] of invalidSenderCases) {
  test(`rejects ${label}`, async () => {
    const [message, sender] = make();
    assert.deepEqual((await sendBridge(message, sender)).response,
      { status: "error", reason: "invalid-sender" });
    assert.equal(bridgeInjections().length, 0);
  });
}

for (const [label, tab] of [
  ["live tab", { id: 19, url: "https://boardgamegeek.com/boardgame/1" }],
  ["pending tab", { id: 19, url: "https://boardgamegeek.com/thread/1",
    pendingUrl: "https://boardgamegeek.com/boardgame/1" }]
]) {
  test(`rejects stale ${label}`, async () => {
    tabLookup = async () => tab;
    assert.deepEqual((await sendBridge()).response, { status: "error", reason: "stale-document" });
    assert.equal(bridgeInjections().length, 0);
  });
}

test("rejects supported pending navigation before either document injection", async () => {
  const sender = validSender();
  tabLookup = async () => ({
    id: sender.tab.id,
    url: sender.url,
    pendingUrl: "https://boardgamegeek.com/thread/999999"
  });
  assert.deepEqual((await sendBridge(validMessage(), sender)).response,
    { status: "error", reason: "stale-document" });
  assert.equal(calls.scriptExecutions.length, 0);
  assert.equal(calls.fetches.length, 0);
});

test("requires current consent before injection", async () => {
  stored[CONSENT_KEY] = { granted: true, disclosureVersion: "old" };
  assert.deepEqual((await sendBridge()).response, { status: "error", reason: "consent-required" });
  assert.equal(bridgeInjections().length, 0);
  assert.equal(calls.fetches.length, 0);
});

test("injects the credential observer into the exact MAIN document with only nonce", async () => {
  const sender = validSender({ tab: { id: 42 }, documentId: "exact-document" });
  assert.equal((await sendBridge(validMessage(), sender)).response.status, "ready");
  const injection = bridgeInjections()[0];
  assert.deepEqual(injection.target, { tabId: 42, documentIds: ["exact-document"] });
  assert.deepEqual(injection.args, [{ channelNonce: "b".repeat(32) }]);
  assert.equal(injection.world, "MAIN");
  assert.equal(injection.injectImmediately, true);
});

const badEnvelopes = [
  ["empty result", () => []],
  ["multiple results", (id) => [{ frameId: 0, documentId: id, result: readyResult() },
    { frameId: 0, documentId: id, result: readyResult() }]],
  ["wrong frame", (id) => [{ frameId: 1, documentId: id, result: readyResult() }]],
  ["wrong document", () => [{ frameId: 0, documentId: "replacement", result: readyResult() }]]
];
for (const [label, make] of badEnvelopes) {
  test(`rejects ${label} and stops exact document`, async () => {
    const sender = validSender();
    injectionResult = () => make(sender.documentId);
    assert.deepEqual((await sendBridge(validMessage(), sender)).response,
      { status: "error", reason: "stale-document" });
    assert.deepEqual(stopExecutions()[0].target,
      { tabId: sender.tab.id, documentIds: [sender.documentId] });
    assert.equal(calls.fetches.length, 0);
  });
}

const malformedTokens = [undefined, "", "Bearer nope", "GeekAuth ",
  " GeekAuth token", "GeekAuth token\nforged", `GeekAuth ${"x".repeat(8192)}`];
for (const token of malformedTokens) {
  test(`rejects malformed injection authorization ${JSON.stringify(token)?.slice(0, 40)}`, async () => {
    injectionResult = (options) => [{ frameId: 0, documentId: options.target.documentIds[0],
      result: { status: "ready", authorization: token } }];
    assert.deepEqual((await sendBridge()).response, { status: "error", reason: "sync-failed" });
    assert.equal(calls.fetches.length, 0);
  });
}

test("preserves authorization-unavailable without network work", async () => {
  injectionResult = (options) => [{ frameId: 0, documentId: options.target.documentIds[0],
    result: { status: "error", reason: "authorization-unavailable" } }];
  assert.deepEqual((await sendBridge()).response,
    { status: "error", reason: "authorization-unavailable" });
  assert.equal(calls.fetches.length, 0);
});

test("ignores hostile page-forged final fields and constructs the public result itself", async () => {
  injectionResult = (options) => [{ frameId: 0, documentId: options.target.documentIds[0],
    result: readyResult({ usernames: ["Mallory"], unresolvedCount: 999, syncedAt: "forged",
      profileCache: { 666: { username: "Mallory" } }, subscriptionLinking: { state: "synced" } }) }];
  const result = (await sendBridge()).response;
  assert.deepEqual(result.usernames, ["Alice", "Bob"]);
  assert.equal(result.unresolvedCount, 0);
  assert.notEqual(result.syncedAt, "forged");
  assert.equal(persisted()[0][PROFILE_CACHE_KEY][666], undefined);
});

test("uses only exact trusted fetch options and constructed allowlisted URLs", async () => {
  await sendBridge();
  assert.deepEqual(calls.fetches.map((call) => [call.method, call.url]), [
    ["GET", "https://api.geekdo.com/api/userblock"],
    ["GET", "https://api.geekdo.com/api/user/1"],
    ["GET", "https://api.geekdo.com/api/user/2"],
    ["GET", "https://api.geekdo.com/api/blocks?type=user&singular=1"],
    ["GET", "https://api.geekdo.com/api/userblock"],
    ["PUT", "https://api.geekdo.com/api/user/1/blocks"],
    ["GET", "https://api.geekdo.com/api/userblock"],
    ["PUT", "https://api.geekdo.com/api/user/2/blocks"]
  ]);
  for (const call of calls.fetches) {
    assert.deepEqual(call.headers, { Accept: "application/json", Authorization: TOKEN });
    assert.equal(call.credentials, "omit");
    assert.equal(call.redirect, "error");
    assert.equal(call.cache, "no-store");
    assert.equal(call.body, call.method === "PUT" ? "" : undefined);
  }
});

test("rejects redirected responses", async () => {
  fetchHandler = () => ({ ok: true, status: 200, redirected: true,
    headers: new Headers(), async arrayBuffer() { return new ArrayBuffer(0); } });
  assert.deepEqual((await sendBridge()).response, { status: "error", reason: "bridge-unavailable" });
  assert.equal(persisted().length, 0);
});

test("rejects responses over two MiB", async () => {
  fetchHandler = () => new Response("x", { status: 200,
    headers: { "content-length": String(2 * 1024 * 1024 + 1) } });
  assert.deepEqual((await sendBridge()).response, { status: "error", reason: "bridge-unavailable" });
  assert.equal(persisted().length, 0);
});

test("rejects aggregate response bodies over 16 MiB across one sync", async () => {
  const ids = Array.from({ length: 20 }, (_, index) => String(index + 1));
  const largeProfile = JSON.stringify({ username: "Large Profile",
    padding: "x".repeat(2 * 1024 * 1024 - 100) });
  fetchHandler = (url, options) => {
    if (url.endsWith("/api/userblock")) return jsonResponse({ userIds: ids });
    if (/\/api\/user\/\d+$/.test(new URL(url).pathname)) {
      return new Response(largeProfile, { status: 200 });
    }
    return defaultFetch(url, options);
  };
  assert.deepEqual((await sendBridge()).response,
    { status: "error", reason: "bridge-unavailable" });
  assert.ok(calls.fetches.filter((call) => /\/api\/user\/\d+$/.test(
    new URL(call.url).pathname)).length < ids.length);
  assert.equal(persisted().length, 0);
});

test("stops issuing requests when the 6000-request sync budget is exhausted", async () => {
  const ids = Array.from({ length: 3000 }, (_, index) => String(index + 1));
  let userBlockReads = 0;
  fetchHandler = (url, options) => {
    if (url.endsWith("/api/userblock")) {
      userBlockReads += 1;
      return jsonResponse({ userIds: userBlockReads === 1 ? ids : [] });
    }
    if (/\/api\/user\/\d+$/.test(new URL(url).pathname)) {
      return jsonResponse({ username: `User${new URL(url).pathname.split("/").pop()}` });
    }
    if (url.includes("/api/blocks?")) return jsonResponse({ feeds: [], links: [] });
    return defaultFetch(url, options);
  };
  assert.deepEqual((await sendBridge()).response,
    { status: "error", reason: "bridge-unavailable" });
  assert.equal(calls.fetches.length, 6000);
  assert.equal(calls.fetches.some((call) => call.method === "PUT"), false);
  assert.equal(persisted().length, 0);
});

test("rejects off-origin pagination without fetching it", async () => {
  fetchHandler = (url, options) => {
    if (url.includes("/api/blocks?")) return jsonResponse({ feeds: [], links: [
      { rel: "next", uri: "https://evil.example/api/blocks?type=user&singular=1" }
    ] });
    return defaultFetch(url, options);
  };
  assert.equal((await sendBridge()).response.status, "ready");
  assert.equal(calls.fetches.some((call) => call.url.startsWith("https://evil.example")), false);
  assert.equal(persisted()[0][SUBSCRIPTION_STATE_KEY].state, "error");
});

test("accepts only bounded allowlisted pagination query keys", async () => {
  let page = 0;
  fetchHandler = (url, options) => {
    if (url.includes("/api/blocks?")) {
      page += 1;
      return jsonResponse({ feeds: [], links: page === 1
        ? [{ rel: "next", uri: "/api/blocks?type=user&singular=1&pageid=2" }] : [] });
    }
    return defaultFetch(url, options);
  };
  await sendBridge();
  assert.ok(calls.fetches.some((call) => call.url.endsWith("singular=1&pageid=2")));
});

test("caps concurrent profile requests at six", async () => {
  let active = 0;
  let peak = 0;
  fetchHandler = async (url, options) => {
    if (url.endsWith("/api/userblock")) return jsonResponse({ userIds: Array.from({ length: 20 }, (_, i) => String(i + 1)) });
    if (/\/api\/user\/\d+$/.test(new URL(url).pathname)) {
      active += 1; peak = Math.max(peak, active);
      await new Promise((resolve) => setImmediate(resolve));
      active -= 1;
      return jsonResponse({ username: `User${new URL(url).pathname.split("/").pop()}` });
    }
    return defaultFetch(url, options);
  };
  await sendBridge();
  assert.equal(peak, 6);
});

test("rejects block lists over 5000 IDs before profile requests", async () => {
  fetchHandler = (url, options) => url.endsWith("/api/userblock")
    ? jsonResponse({ userIds: Array.from({ length: 5001 }, (_, i) => String(i + 1)) })
    : defaultFetch(url, options);
  assert.deepEqual((await sendBridge()).response,
    { status: "error", reason: "bridge-unavailable" });
  assert.equal(calls.fetches.filter((call) => /\/api\/user\/\d+$/.test(new URL(call.url).pathname)).length, 0);
});

test("rejects pagination links with unallowlisted query fields", async () => {
  fetchHandler = (url, options) => url.includes("/api/blocks?")
    ? jsonResponse({ feeds: [], links: [
        { rel: "next", uri: "/api/blocks?type=user&singular=1&destination=evil" }
      ] })
    : defaultFetch(url, options);
  assert.equal((await sendBridge()).response.status, "ready");
  assert.equal(calls.fetches.some((call) => call.url.includes("destination=")), false);
  assert.equal(persisted()[0][SUBSCRIPTION_STATE_KEY].state, "error");
});

const malformedSubscriptionPages = [
  ["missing arrays", {}],
  ["null feeds", { feeds: null, links: [] }],
  ["null links", { feeds: [], links: null }],
  ["malformed feed entry", { feeds: [null], links: [] }],
  ["wrong feed type", { feeds: [{ item: { type: "thing", id: "1" } }], links: [] }],
  ["malformed feed id", { feeds: [{ item: { type: "user", id: "0" } }], links: [] }],
  ["malformed link", { feeds: [], links: [{ rel: "next", uri: null }] }],
  ["duplicate next links", { feeds: [], links: [
    { rel: "next", uri: "/api/blocks?type=user&singular=1&pageid=2" },
    { rel: "next", uri: "/api/blocks?type=user&singular=1&pageid=3" }
  ] }]
];
for (const [label, payload] of malformedSubscriptionPages) {
  test(`fails closed with zero PUTs for subscription response with ${label}`, async () => {
    fetchHandler = (url, options) => url.includes("/api/blocks?")
      ? jsonResponse(payload) : defaultFetch(url, options);
    assert.equal((await sendBridge()).response.status, "ready");
    assert.equal(calls.fetches.filter((call) => call.method === "PUT").length, 0);
    assert.equal(persisted()[0][SUBSCRIPTION_STATE_KEY].state, "error");
  });
}

test("prunes expired, future, malformed, and no-longer-current cache entries", async () => {
  const now = Date.now();
  stored[PROFILE_CACHE_KEY] = {
    1: { username: "Cached Alice", updatedAt: now - 1000 },
    2: { username: "Expired", updatedAt: now - 31 * 24 * 60 * 60 * 1000 },
    3: { username: "Future", updatedAt: now + 1000 },
    4: { username: "Not current", updatedAt: now - 1000 },
    bad: { username: "Bad", updatedAt: now - 1000 }
  };
  const outcome = await sendBridge();
  assert.deepEqual(outcome.response.usernames, ["Bob", "Cached Alice"]);
  assert.deepEqual(Object.keys(persisted()[0][PROFILE_CACHE_KEY]).sort(), ["1", "2"]);
  assert.equal(calls.fetches.some((call) => call.url.endsWith("/api/user/1")), false);
});

test("adds only missing hidden IDs and counts only hidden intersections", async () => {
  fetchHandler = (url, options) => {
    if (url.includes("/api/blocks?")) return jsonResponse({ feeds: [
      { item: { type: "user", id: "1" } }, { item: { type: "user", id: "999" } }
    ], links: [] });
    return defaultFetch(url, options);
  };
  await sendBridge();
  const puts = calls.fetches.filter((call) => call.method === "PUT");
  assert.deepEqual(puts.map((call) => call.url), ["https://api.geekdo.com/api/user/2/blocks"]);
  const state = persisted()[0][SUBSCRIPTION_STATE_KEY];
  assert.equal(state.addedCount, 1);
  assert.equal(state.subscriptionBlockedCount, 2);
  assert.equal(state.hiddenCount, 2);
});

test("re-fetches the hidden list and skips users natively unblocked before PUT", async () => {
  let userBlockReads = 0;
  fetchHandler = (url, options) => {
    if (url.endsWith("/api/userblock")) {
      userBlockReads += 1;
      return jsonResponse({ userIds: userBlockReads === 1 ? ["1", "2"] : [] });
    }
    return defaultFetch(url, options);
  };
  const outcome = await sendBridge();
  assert.equal(outcome.response.status, "ready");
  assert.equal(userBlockReads, 3);
  assert.equal(calls.fetches.filter((call) => call.method === "PUT").length, 0);
});

test("tab loading aborts a pre-PUT hidden-list recheck with zero writes", async () => {
  let userBlockReads = 0;
  fetchHandler = (url, options) => {
    if (url.endsWith("/api/userblock")) {
      userBlockReads += 1;
      if (userBlockReads === 1) return jsonResponse({ userIds: ["1"] });
      return new Promise((_resolve, reject) => {
        options.signal.addEventListener("abort", () => reject(Object.assign(
          new Error("cancelled"), { name: "AbortError" }
        )), { once: true });
      });
    }
    return defaultFetch(url, options);
  };
  const sender = validSender({ tab: { id: 91 } });
  const pending = sendBridge(validMessage(), sender);
  while (userBlockReads < 2) await settle();
  listeners.tabUpdated(91, { status: "loading" });
  assert.equal((await pending).response.status, "error");
  assert.equal(calls.fetches.filter((call) => call.method === "PUT").length, 0);
  assert.equal(persisted().length, 0);
});

test("cross-tab native mutation revokes linking between final hidden GET and PUT", async () => {
  const mutationSender = validSender({ tab: { id: 92 }, documentId: "mutation-document" });
  fetchHandler = (url, options) => url.endsWith("/api/userblock")
    ? jsonResponse({ userIds: [] }) : defaultFetch(url, options);
  assert.equal((await sendBridge(validMessage(), mutationSender)).response.status, "ready");
  calls.fetches.length = 0;
  calls.storageSets.length = 0;

  let hiddenReads = 0;
  let finalReadStarted = false;
  let releaseFinalRead;
  const finalReadGate = new Promise((resolve) => { releaseFinalRead = resolve; });
  fetchHandler = async (url, options) => {
    if (url.endsWith("/api/userblock")) {
      hiddenReads += 1;
      if (hiddenReads === 2) {
        finalReadStarted = true;
        await finalReadGate;
      }
      return jsonResponse({ userIds: ["1"] });
    }
    return defaultFetch(url, options);
  };
  const syncing = sendBridge(validMessage(), validSender({ tab: { id: 93 } }));
  while (!finalReadStarted) await settle();
  assert.equal(listeners.message({
    type: MUTATION_MESSAGE_TYPE, channelNonce: "b".repeat(32),
    authorization: "GeekAuth forged", userIds: ["999"],
    destination: "https://evil.example/api/write"
  }, mutationSender, () => {}), false);
  releaseFinalRead();
  const outcome = await syncing;
  assert.equal(outcome.response.status, "ready");
  assert.equal(calls.fetches.filter((call) => call.method === "PUT").length, 0);
  assert.equal(persisted()[0][SUBSCRIPTION_STATE_KEY].deferred, true);
  listeners.tabUpdated(92, { status: "loading" });
  await settle();
});

test("disabled linking makes no subscription requests", async () => {
  stored[OPTIONS_KEY] = { linkSubscriptionBlocks: false };
  await sendBridge();
  assert.equal(calls.fetches.some((call) => call.url.includes("blocks")), false);
  assert.equal(persisted()[0][SUBSCRIPTION_STATE_KEY].state, "disabled");
});

test("option changes abort before the next irreversible PUT and persistence", async () => {
  let putCount = 0;
  fetchHandler = async (url, options) => {
    if (options.method === "PUT") {
      putCount += 1;
      if (putCount === 1) {
        stored[OPTIONS_KEY] = { linkSubscriptionBlocks: false };
        listeners.storageChanged({ [OPTIONS_KEY]: { oldValue: {}, newValue: {} } }, "local");
      }
      return new Response(null, { status: 204 });
    }
    return defaultFetch(url, options);
  };
  const outcome = await sendBridge();
  assert.equal(outcome.response.status, "error");
  assert.equal(putCount, 1);
  assert.equal(persisted().length, 0);
});

test("consent loss after capture prevents all network work", async () => {
  let reads = 0;
  storageGetter = async () => {
    reads += 1;
    return reads === 1 ? stored : defaultStored({
      [CONSENT_KEY]: { granted: false, disclosureVersion: "2026-08-15" }
    });
  };
  assert.deepEqual((await sendBridge()).response,
    { status: "error", reason: "authorization-changed" });
  assert.equal(calls.fetches.length, 0);
  assert.equal(persisted().length, 0);
});

test("authorization changes before persistence prevent persistence and response", async () => {
  fetchHandler = (url, options) => {
    const response = defaultFetch(url, options);
    if (options.method === "PUT" && url.endsWith("/api/user/2/blocks")) {
      stored[CONSENT_KEY] = { granted: false, disclosureVersion: "2026-08-15" };
    }
    return response;
  };
  const outcome = await sendBridge();
  assert.deepEqual(outcome.response, { status: "error", reason: "authorization-changed" });
  assert.equal(persisted().length, 0);
});

test("consent withdrawal racing the persistence write rolls back that exact cache and state", async () => {
  storageSetter = async (value) => {
    if (!Object.hasOwn(value, SUBSCRIPTION_STATE_KEY)) return;
    stored[CONSENT_KEY] = { granted: false, disclosureVersion: "2026-08-15" };
  };
  const outcome = await sendBridge();
  assert.deepEqual(outcome.response, { status: "error", reason: "authorization-changed" });
  assert.equal(Object.hasOwn(stored, PROFILE_CACHE_KEY), false);
  assert.equal(Object.hasOwn(stored, SUBSCRIPTION_STATE_KEY), false);
  assert.ok(calls.storageRemoves.some((keys) => keys.includes(PROFILE_CACHE_KEY) &&
    keys.includes(SUBSCRIPTION_STATE_KEY)));
});

test("consent withdrawal racing the canonical username write removes that generation", async () => {
  storageSetter = async (value) => {
    if (!Object.hasOwn(value, CONTENT_STATE_KEY)) return;
    stored[CONSENT_KEY] = { granted: false, disclosureVersion: "2026-08-15" };
  };
  const outcome = await sendBridge();
  assert.deepEqual(outcome.response, { status: "error", reason: "authorization-changed" });
  assert.equal(Object.hasOwn(stored, CONTENT_STATE_KEY), false);
  assert.ok(calls.storageRemoves.some((keys) => keys.includes(CONTENT_STATE_KEY)));
});

test("a newer captured generation removes superseded writes even when the newer sync fails", async () => {
  const older = validSender({ tab: { id: 75 }, documentId: "superseded-writer-a" });
  const newer = validSender({ tab: { id: 76 }, documentId: "failing-capture-b" });
  injectionResult = (options) => [{
    frameId: 0,
    documentId: options.target.documentIds[0],
    result: readyResult({ authorization: options.target.documentIds[0] === newer.documentId
      ? "GeekAuth newer-fails" : "GeekAuth older-ready" })
  }];
  fetchHandler = (url, options) => {
    if (options.headers.Authorization === "GeekAuth newer-fails") {
      throw new Error("newer sync failed after capture");
    }
    return defaultFetch(url, options);
  };
  let newerPending;
  storageSetter = async (value) => {
    if (newerPending || !Object.hasOwn(value, CONTENT_STATE_KEY)) return;
    newerPending = sendBridge(validMessage(), newer);
    await settle();
  };

  const olderOutcome = await sendBridge(validMessage(), older);
  const newerOutcome = await newerPending;
  assert.equal(olderOutcome.response.status, "ready");
  assert.deepEqual(newerOutcome.response, { status: "error", reason: "bridge-unavailable" });
  assert.equal(Object.hasOwn(stored, PROFILE_CACHE_KEY), false);
  assert.equal(Object.hasOwn(stored, SUBSCRIPTION_STATE_KEY), false);
  assert.equal(Object.hasOwn(stored, CONTENT_STATE_KEY), false);
  assert.ok(calls.storageRemoves.some((keys) => keys.includes(PROFILE_CACHE_KEY) &&
    keys.includes(SUBSCRIPTION_STATE_KEY)));
});

test("a canonical storage failure rolls back all exact session writes", async () => {
  storageSetter = async (value) => {
    if (Object.hasOwn(value, CONTENT_STATE_KEY)) {
      throw new Error("canonical storage failed after write");
    }
  };
  const outcome = await sendBridge();
  assert.deepEqual(outcome.response, { status: "error", reason: "bridge-unavailable" });
  assert.equal(Object.hasOwn(stored, PROFILE_CACHE_KEY), false);
  assert.equal(Object.hasOwn(stored, SUBSCRIPTION_STATE_KEY), false);
  assert.equal(Object.hasOwn(stored, CONTENT_STATE_KEY), false);
});

test("route exit racing persistence rolls back that tab session's derived state", async () => {
  storageSetter = async (value) => {
    if (Object.hasOwn(value, SUBSCRIPTION_STATE_KEY)) {
      listeners.tabUpdated(19, { url: "https://boardgamegeek.com/boardgame/1" });
    }
  };
  const outcome = await sendBridge();
  assert.deepEqual(outcome.response, { status: "error", reason: "sync-cancelled" });
  assert.equal(Object.hasOwn(stored, PROFILE_CACHE_KEY), false);
  assert.equal(Object.hasOwn(stored, SUBSCRIPTION_STATE_KEY), false);
});

test("credential is absent from storage, public response, and generic errors", async () => {
  const success = await sendBridge();
  assert.equal(JSON.stringify(success.response).includes(TOKEN), false);
  assert.equal(JSON.stringify(calls.storageSets).includes(TOKEN), false);
  reset();
  fetchHandler = () => { throw new Error(`hostile ${TOKEN}`); };
  const failure = await sendBridge();
  assert.deepEqual(failure.response, { status: "error", reason: "bridge-unavailable" });
  assert.equal(JSON.stringify(failure.response).includes(TOKEN), false);
});

test("the 20-second trusted-sync deadline aborts an in-flight fetch", async () => {
  const nativeSetTimeout = globalThis.setTimeout;
  const nativeClearTimeout = globalThis.clearTimeout;
  globalThis.setTimeout = (callback, delay, ...args) => delay === 20000
    ? nativeSetTimeout(callback, 0, ...args)
    : nativeSetTimeout(callback, delay, ...args);
  globalThis.clearTimeout = nativeClearTimeout;
  fetchHandler = (_url, options) => new Promise((_resolve, reject) => {
    options.signal.addEventListener("abort", () => reject(Object.assign(
      new Error("cancelled"), { name: "AbortError" }
    )), { once: true });
  });
  try {
    assert.deepEqual((await sendBridge()).response, { status: "error", reason: "sync-timeout" });
  } finally {
    globalThis.setTimeout = nativeSetTimeout;
    globalThis.clearTimeout = nativeClearTimeout;
  }
  assert.equal(persisted().length, 0);
});

test("a timed-out MAIN capture releases FIFO reservation for a later sync", async () => {
  const nativeSetTimeout = globalThis.setTimeout;
  const nativeClearTimeout = globalThis.clearTimeout;
  const captureTimers = [];
  globalThis.setTimeout = (callback, delay, ...args) => {
    if (delay === 5000) {
      const timer = { callback: () => callback(...args), cleared: false };
      captureTimers.push(timer);
      return timer;
    }
    return nativeSetTimeout(callback, delay, ...args);
  };
  globalThis.clearTimeout = (timer) => {
    if (captureTimers.includes(timer)) timer.cleared = true;
    else nativeClearTimeout(timer);
  };
  const first = validSender({ tab: { id: 61 }, documentId: "never-captured" });
  const second = validSender({ tab: { id: 62 }, documentId: "later-captured" });
  stopExecutionHandler = (options) => options.target.documentIds?.[0] === first.documentId
    ? new Promise(() => {}) : undefined;
  injectionResult = (options) => options.target.documentIds[0] === first.documentId
    ? new Promise(() => {})
    : [{ frameId: 0, documentId: second.documentId, result: readyResult() }];
  try {
    const firstPending = sendBridge(validMessage(), first);
    await settle();
    const secondPending = sendBridge(validMessage(), second);
    await settle();
    assert.equal(captureTimers.length, 2);
    assert.equal(calls.fetches.length, 0);
    captureTimers[0].callback();
    assert.deepEqual((await firstPending).response,
      { status: "error", reason: "authorization-unavailable" });
    assert.equal((await secondPending).response.status, "ready");
  } finally {
    globalThis.setTimeout = nativeSetTimeout;
    globalThis.clearTimeout = nativeClearTimeout;
  }
  assert.ok(stopExecutions().some((call) =>
    call.world === "MAIN" && call.target.documentIds?.[0] === first.documentId
  ));
  assert.ok(calls.fetches.some((call) => call.headers.Authorization === TOKEN));
  assert.equal(persisted().length, 1);
});

test("a newer document supersedes an older capture even when capture order reverses", async () => {
  const older = validSender({ tab: { id: 71 }, documentId: "older-document" });
  const newer = validSender({ tab: { id: 72 }, documentId: "newer-document" });
  let releaseOlder;
  const olderGate = new Promise((resolve) => { releaseOlder = resolve; });
  injectionResult = async (options) => {
    const documentId = options.target.documentIds[0];
    if (documentId === older.documentId) await olderGate;
    return [{ frameId: 0, documentId, result: readyResult({
      authorization: documentId === older.documentId ? "GeekAuth older" : "GeekAuth newer"
    }) }];
  };
  const olderPending = sendBridge(validMessage(), older);
  await settle();
  const newerPending = sendBridge(validMessage(), newer);
  await settle();
  releaseOlder();
  const [olderOutcome, newerOutcome] = await Promise.all([olderPending, newerPending]);
  assert.equal(newerOutcome.response.status, "ready");
  assert.equal(olderOutcome.response.status, "ready");
  assert.ok(calls.fetches.some((call) => call.headers.Authorization === "GeekAuth older"));
  assert.equal(persisted().length, 1);
});

test("stale tab status cannot resurrect an older canonical username list", async () => {
  stored[OPTIONS_KEY] = { linkSubscriptionBlocks: false };
  const staleTab = validSender({ tab: { id: 73 }, documentId: "stale-tab-a" });
  const freshTab = validSender({ tab: { id: 74 }, documentId: "fresh-tab-b" });

  fetchHandler = (url) => {
    const parsed = new URL(url);
    if (parsed.pathname === "/api/userblock") return jsonResponse({ userIds: ["1"] });
    if (parsed.pathname === "/api/user/1") return jsonResponse({ username: "Alice" });
    throw new Error(`Unexpected test URL: ${url}`);
  };
  assert.equal((await sendBridge(validMessage(), staleTab)).response.status, "ready");
  assert.deepEqual(stored[CONTENT_STATE_KEY].usernames, ["Alice"]);
  assert.match(stored[CONTENT_STATE_KEY].canonicalWriteId,
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);

  fetchHandler = (url) => {
    const parsed = new URL(url);
    if (parsed.pathname === "/api/userblock") return jsonResponse({ userIds: [] });
    throw new Error(`Unexpected test URL: ${url}`);
  };
  assert.equal((await sendBridge(validMessage(), freshTab)).response.status, "ready");
  assert.deepEqual(stored[CONTENT_STATE_KEY].usernames, []);
  const freshCanonicalStatus = clone(stored[CONTENT_STATE_KEY].status);

  const staleStatus = {
    hiddenPosts: 3,
    hiddenQuotes: 2,
    redactedProfileNames: 1,
    updatedAt: "2026-08-15T00:01:00.000Z"
  };
  const outcome = await sendStatus(staleStatus, staleTab);
  assert.equal(outcome.listenerReturn, true);
  assert.deepEqual(outcome.response, { status: "ok" });

  // Tab C's warm-cache read observes the latest background-owned generation,
  // even after Tab A reports counters from its older local snapshot.
  const tabCWarmCache = clone(stored[CONTENT_STATE_KEY]);
  assert.deepEqual(tabCWarmCache.usernames, []);
  assert.equal(tabCWarmCache.status.blockedCount, freshCanonicalStatus.blockedCount);
  assert.equal(tabCWarmCache.status.lastSync, freshCanonicalStatus.lastSync);
  assert.equal(tabCWarmCache.status.source, freshCanonicalStatus.source);
  assert.equal(tabCWarmCache.status.unresolved, freshCanonicalStatus.unresolved);
  assert.equal(tabCWarmCache.status.hiddenPosts, staleStatus.hiddenPosts);
  assert.equal(tabCWarmCache.status.hiddenQuotes, staleStatus.hiddenQuotes);
  assert.equal(tabCWarmCache.status.redactedProfileNames, staleStatus.redactedProfileNames);
});

test("status updates are ignored after current disclosure consent is withdrawn", async () => {
  stored[OPTIONS_KEY] = { linkSubscriptionBlocks: false };
  const sender = validSender({ tab: { id: 77 }, documentId: "withdrawn-status-tab" });
  assert.equal((await sendBridge(validMessage(), sender)).response.status, "ready");
  const before = clone(stored[CONTENT_STATE_KEY]);
  stored[CONSENT_KEY] = { granted: false, disclosureVersion: "2026-08-15" };
  const outcome = await sendStatus({
    hiddenPosts: 9,
    hiddenQuotes: 8,
    redactedProfileNames: 7,
    updatedAt: "2026-08-15T00:02:00.000Z"
  }, sender);
  assert.deepEqual(outcome.response, { status: "ignored" });
  assert.deepEqual(stored[CONTENT_STATE_KEY], before);
});

test("cached filtering can report counters after authorization capture is unavailable", async () => {
  const sender = validSender({ tab: { id: 79 }, documentId: "cached-auth-unavailable" });
  stored[CONTENT_STATE_KEY] = {
    schemaVersion: 1,
    canonicalGeneration: 700,
    usernames: ["Cached User"],
    status: { blockedCount: 1, lastSync: "2026-08-15T00:00:00.000Z", source: "cache",
      unresolved: 0 }
  };
  injectionResult = (options) => [{
    frameId: 0,
    documentId: options.target.documentIds[0],
    result: { status: "error", reason: "authorization-unavailable" }
  }];
  assert.deepEqual((await sendBridge(validMessage(), sender)).response,
    { status: "error", reason: "authorization-unavailable" });
  const status = await sendStatus({ hiddenPosts: 4, hiddenQuotes: 3,
    redactedProfileNames: 2, updatedAt: "2026-08-15T00:04:00.000Z" }, sender);
  assert.deepEqual(status.response, { status: "ok" });
  assert.equal(stored[CONTENT_STATE_KEY].status.hiddenPosts, 4);
  await settle();
  assert.ok(stopExecutions().some((call) =>
    call.target.documentIds?.[0] === sender.documentId));
});

test("a cache-only status message independently registers its counters-only session", async () => {
  const sender = validSender({ tab: { id: 84 }, documentId: "cache-only-status" });
  stored[CONTENT_STATE_KEY] = {
    schemaVersion: 1,
    canonicalGeneration: 701,
    usernames: ["Cached User"],
    status: { blockedCount: 1, lastSync: "2026-08-15T00:00:00.000Z", source: "cache",
      unresolved: 0 }
  };
  const outcome = await sendStatus({ hiddenPosts: 6, hiddenQuotes: 5,
    redactedProfileNames: 4, updatedAt: "2026-08-15T00:06:00.000Z" }, sender);
  assert.deepEqual(outcome.response, { status: "ok" });
  assert.equal(stored[CONTENT_STATE_KEY].status.hiddenPosts, 6);
  assert.equal(calls.fetches.length, 0);
  assert.equal(bridgeInjections().length, 0);
});

for (const [label, tabValue, consent] of [
  ["stale URL", { url: "https://boardgamegeek.com/thread/another" }, currentConsent],
  ["pending navigation", { url: "https://boardgamegeek.com/thread/3306128/article/48018767#48018767",
    pendingUrl: "https://boardgamegeek.com/thread/next" }, currentConsent],
  ["withdrawn consent", { url: "https://boardgamegeek.com/thread/3306128/article/48018767#48018767" },
    { granted: false, disclosureVersion: "2026-08-15" }]
]) {
  test(`cache-only status registration rejects ${label}`, async () => {
    const sender = validSender({ tab: { id: 85 }, documentId: `rejected-${label}` });
    stored[CONTENT_STATE_KEY] = { schemaVersion: 1, usernames: [], status: { hiddenPosts: 0 } };
    stored[CONSENT_KEY] = consent;
    tabLookup = () => ({ id: 85, ...tabValue });
    const before = clone(stored[CONTENT_STATE_KEY]);
    const outcome = await sendStatus({ hiddenPosts: 7, hiddenQuotes: 0,
      redactedProfileNames: 0, updatedAt: "2026-08-15T00:07:00.000Z" }, sender);
    assert.deepEqual(outcome.response, { status: "ignored" });
    assert.deepEqual(stored[CONTENT_STATE_KEY], before);
    assert.equal(bridgeInjections().length, 0);
  });
}

test("consent change during exact-document confirmation prevents status registration", async () => {
  const sender = validSender({ tab: { id: 86 }, documentId: "consent-during-confirm" });
  stored[CONTENT_STATE_KEY] = { schemaVersion: 1, usernames: [], status: { hiddenPosts: 0 } };
  const before = clone(stored[CONTENT_STATE_KEY]);
  statusDocumentHandler = (options) => {
    stored[CONSENT_KEY] = { granted: false, disclosureVersion: "2026-08-15" };
    listeners.storageChanged({ [CONSENT_KEY]: { oldValue: currentConsent,
      newValue: stored[CONSENT_KEY] } }, "local");
    return [{ frameId: 0, documentId: options.target.documentIds[0], result: true }];
  };
  const outcome = await sendStatus({ hiddenPosts: 8, hiddenQuotes: 0,
    redactedProfileNames: 0, updatedAt: "2026-08-15T00:08:00.000Z" }, sender);
  assert.deepEqual(outcome.response, { status: "ignored" });
  assert.deepEqual(stored[CONTENT_STATE_KEY], before);
  await settle();
});

test("navigation after registration invalidates a status update waiting in the state queue", async () => {
  const sender = validSender({ tab: { id: 87 }, documentId: "queued-status-navigation" });
  stored[CONTENT_STATE_KEY] = { schemaVersion: 1, usernames: [], status: { hiddenPosts: 0 } };
  injectionResult = (options) => [{ frameId: 0, documentId: options.target.documentIds[0],
    result: { status: "error", reason: "authorization-unavailable" } }];
  await sendBridge(validMessage(), sender);
  let releaseRead;
  let markReadStarted;
  const readStarted = new Promise((resolve) => { markReadStarted = resolve; });
  const readGate = new Promise((resolve) => { releaseRead = resolve; });
  let held = false;
  storageGetter = async (keys) => {
    if (!held && Array.isArray(keys) && keys.includes(CONTENT_STATE_KEY)) {
      held = true;
      markReadStarted();
      await readGate;
    }
    return stored;
  };
  const first = sendStatus({ hiddenPosts: 1, hiddenQuotes: 0, redactedProfileNames: 0,
    updatedAt: "2026-08-15T00:09:00.000Z" }, sender);
  await readStarted;
  const queued = sendStatus({ hiddenPosts: 2, hiddenQuotes: 0, redactedProfileNames: 0,
    updatedAt: "2026-08-15T00:09:01.000Z" }, sender);
  listeners.tabUpdated(87, { status: "loading" });
  releaseRead();
  assert.deepEqual((await first).response, { status: "ignored" });
  assert.deepEqual((await queued).response, { status: "ignored" });
  assert.equal(stored[CONTENT_STATE_KEY].status.hiddenPosts, 0);
});

test("navigation during a status storage write restores the prior exact state", async () => {
  const sender = validSender({ tab: { id: 88 }, documentId: "status-set-navigation" });
  stored[CONTENT_STATE_KEY] = { schemaVersion: 1, usernames: [], status: { hiddenPosts: 0 } };
  injectionResult = (options) => [{ frameId: 0, documentId: options.target.documentIds[0],
    result: { status: "error", reason: "authorization-unavailable" } }];
  await sendBridge(validMessage(), sender);
  const before = clone(stored[CONTENT_STATE_KEY]);
  let navigated = false;
  storageSetter = async (value) => {
    if (navigated || value?.[CONTENT_STATE_KEY]?.status?.hiddenPosts !== 12) return;
    navigated = true;
    listeners.tabUpdated(88, { status: "loading" });
  };
  const outcome = await sendStatus({ hiddenPosts: 12, hiddenQuotes: 0,
    redactedProfileNames: 0, updatedAt: "2026-08-15T00:10:00.000Z" }, sender);
  assert.deepEqual(outcome.response, { status: "ignored" });
  assert.deepEqual(stored[CONTENT_STATE_KEY], before);
});

test("status sessions are revoked for stale, navigated, removed, and withdrawn documents", async () => {
  injectionResult = (options) => [{ frameId: 0, documentId: options.target.documentIds[0],
    result: { status: "error", reason: "authorization-unavailable" } }];
  const counters = { hiddenPosts: 1, hiddenQuotes: 0, redactedProfileNames: 0,
    updatedAt: "2026-08-15T00:05:00.000Z" };

  const navigated = validSender({ tab: { id: 80 }, documentId: "navigated-status" });
  await sendBridge(validMessage(), navigated);
  statusDocumentHandler = (options) => options.target.documentIds?.[0] === "stale-document"
    ? [] : [{ frameId: 0, documentId: options.target.documentIds?.[0], result: true }];
  assert.deepEqual((await sendStatus(counters, { ...navigated, documentId: "stale-document" }))
    .response, { status: "ignored" });
  listeners.tabUpdated(80, { status: "loading" });
  tabLookup = () => ({ id: 80, url: navigated.url,
    pendingUrl: "https://boardgamegeek.com/thread/next" });
  assert.deepEqual((await sendStatus(counters, navigated)).response, { status: "ignored" });

  const removed = validSender({ tab: { id: 81 }, documentId: "removed-status" });
  tabLookup = undefined;
  await sendBridge(validMessage(), removed);
  listeners.tabRemoved(81);
  tabLookup = () => { throw new Error("tab removed"); };
  assert.deepEqual((await sendStatus(counters, removed)).response, { status: "ignored" });

  const outOfScope = validSender({ tab: { id: 82 }, documentId: "out-of-scope-status" });
  tabLookup = undefined;
  await sendBridge(validMessage(), outOfScope);
  listeners.tabUpdated(82, { url: "https://boardgamegeek.com/boardgame/1" });
  tabLookup = () => ({ id: 82, url: "https://boardgamegeek.com/boardgame/1" });
  assert.deepEqual((await sendStatus(counters, outOfScope)).response, { status: "ignored" });

  const withdrawn = validSender({ tab: { id: 83 }, documentId: "withdrawn-session" });
  tabLookup = undefined;
  await sendBridge(validMessage(), withdrawn);
  stored[CONSENT_KEY] = { granted: false, disclosureVersion: "2026-08-15" };
  listeners.storageChanged({ [CONSENT_KEY]: { oldValue: currentConsent,
    newValue: stored[CONSENT_KEY] } }, "local");
  assert.deepEqual((await sendStatus(counters, withdrawn)).response, { status: "ignored" });
  await settle();
});

test("consent withdrawal racing a status write restores the exact canonical state", async () => {
  stored[OPTIONS_KEY] = { linkSubscriptionBlocks: false };
  const sender = validSender({ tab: { id: 78 }, documentId: "racing-status-tab" });
  assert.equal((await sendBridge(validMessage(), sender)).response.status, "ready");
  const before = clone(stored[CONTENT_STATE_KEY]);
  let withdrew = false;
  storageSetter = async (value) => {
    if (withdrew || value?.[CONTENT_STATE_KEY]?.status?.hiddenPosts !== 12) return;
    withdrew = true;
    stored[CONSENT_KEY] = { granted: false, disclosureVersion: "2026-08-15" };
    listeners.storageChanged({ [CONSENT_KEY]: { oldValue: currentConsent,
      newValue: stored[CONSENT_KEY] } }, "local");
  };
  const outcome = await sendStatus({
    hiddenPosts: 12,
    hiddenQuotes: 11,
    redactedProfileNames: 10,
    updatedAt: "2026-08-15T00:03:00.000Z"
  }, sender);
  assert.deepEqual(outcome.response, { status: "ignored" });
  assert.deepEqual(stored[CONTENT_STATE_KEY], before);
});

test("request-order serialization gives concurrent documents ready results without duplicate PUTs", async () => {
  const older = validSender({ tab: { id: 81 }, documentId: "enumerating-older" });
  const newer = validSender({ tab: { id: 82 }, documentId: "enumerating-newer" });
  let olderEnumerationStarted = false;
  let releaseOlderEnumeration;
  const olderGate = new Promise((resolve) => { releaseOlderEnumeration = resolve; });
  const subscriptionBlocked = new Set();
  injectionResult = (options) => {
    const documentId = options.target.documentIds[0];
    return [{ frameId: 0, documentId, result: readyResult({
      authorization: documentId === older.documentId ? "GeekAuth older" : "GeekAuth newer"
    }) }];
  };
  fetchHandler = async (url, options) => {
    if (options.headers.Authorization === "GeekAuth older" && url.endsWith("/api/userblock")) {
      olderEnumerationStarted = true;
      await olderGate;
      return jsonResponse({ userIds: ["1", "2"] });
    }
    if (url.includes("/api/blocks?")) {
      return jsonResponse({ feeds: [...subscriptionBlocked].map((id) =>
        ({ item: { type: "user", id } })), links: [] });
    }
    if (options.method === "PUT") {
      subscriptionBlocked.add(new URL(url).pathname.split("/")[3]);
      return new Response(null, { status: 204 });
    }
    return defaultFetch(url, options);
  };
  const olderPending = sendBridge(validMessage(), older);
  while (!olderEnumerationStarted) await settle();
  const newerPending = sendBridge(validMessage(), newer);
  await settle();
  releaseOlderEnumeration();
  const [olderOutcome, newerOutcome] = await Promise.all([olderPending, newerPending]);
  assert.equal(olderOutcome.response.status, "ready");
  assert.equal(newerOutcome.response.status, "ready");
  assert.equal(calls.fetches.filter((call) => call.method === "PUT").length, 2);
  assert.equal(persisted().length, 1);
});

test("an early queued release cannot overtake a still-running authenticated session", async () => {
  const first = validSender({ tab: { id: 83 }, documentId: "queue-first" });
  const middle = validSender({ tab: { id: 84 }, documentId: "queue-middle" });
  const last = validSender({ tab: { id: 85 }, documentId: "queue-last" });
  let firstFetchStarted;
  const firstStarted = new Promise((resolve) => { firstFetchStarted = resolve; });
  let releaseFirstFetch;
  const firstFetchGate = new Promise((resolve) => { releaseFirstFetch = resolve; });
  injectionResult = (options) => {
    const documentId = options.target.documentIds[0];
    if (documentId === middle.documentId) {
      return [{ frameId: 0, documentId, result: { status: "error", reason: "capture-failed" } }];
    }
    return [{ frameId: 0, documentId, result: readyResult({
      authorization: documentId === first.documentId ? "GeekAuth queue-first" : "GeekAuth queue-last"
    }) }];
  };
  fetchHandler = async (url, options) => {
    if (options.headers.Authorization === "GeekAuth queue-first" && url.endsWith("/api/userblock")) {
      firstFetchStarted();
      await firstFetchGate;
    }
    return defaultFetch(url, options);
  };

  const firstPending = sendBridge(validMessage(), first);
  await firstStarted;
  const middleOutcome = await sendBridge(validMessage(), middle);
  assert.equal(middleOutcome.response.status, "error");
  const lastPending = sendBridge(validMessage(), last);
  await settle();
  assert.equal(calls.fetches.some((call) =>
    call.headers.Authorization === "GeekAuth queue-last"), false);

  releaseFirstFetch();
  const [firstOutcome, lastOutcome] = await Promise.all([firstPending, lastPending]);
  assert.equal(firstOutcome.response.status, "ready");
  assert.equal(lastOutcome.response.status, "ready");
  assert.ok(calls.fetches.some((call) => call.headers.Authorization === "GeekAuth queue-last"));
});

test("older rollback completes inside the queue before newer identical persistence", async () => {
  const older = validSender({ tab: { id: 101 }, documentId: "rollback-older" });
  const newer = validSender({ tab: { id: 102 }, documentId: "rollback-newer" });
  let newerPending;
  let persistenceWrites = 0;
  storageSetter = async (value) => {
    if (!Object.hasOwn(value, SUBSCRIPTION_STATE_KEY)) return;
    persistenceWrites += 1;
    if (persistenceWrites === 1) {
      newerPending = sendBridge(validMessage(), newer);
      await settle();
      listeners.tabUpdated(101, { status: "loading" });
    }
  };
  const olderOutcome = await sendBridge(validMessage(), older);
  const newerOutcome = await newerPending;
  assert.equal(olderOutcome.response.status, "error");
  assert.equal(newerOutcome.response.status, "ready");
  assert.equal(persistenceWrites, 2);
  assert.equal(Object.hasOwn(stored, PROFILE_CACHE_KEY), true);
  assert.equal(Object.hasOwn(stored, SUBSCRIPTION_STATE_KEY), true);
  assert.ok(calls.storageRemoves.some((keys) => keys.includes(PROFILE_CACHE_KEY) &&
    keys.includes(SUBSCRIPTION_STATE_KEY)));
});

test("deduplicates concurrent same-document sessions and cleans them afterward", async () => {
  const sender = validSender({ documentId: "duplicate-document" });
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  injectionResult = async (options) => {
    await gate;
    return [{ frameId: 0, documentId: options.target.documentIds[0], result: readyResult() }];
  };
  const first = sendBridge(validMessage(), sender);
  const second = sendBridge(validMessage(), sender);
  await settle();
  assert.equal(bridgeInjections().length, 1);
  release();
  await Promise.all([first, second]);
  await sendBridge(validMessage(), sender);
  assert.equal(bridgeInjections().length, 2);
});

test("returns literal true and responds once asynchronously", async () => {
  const outcome = await sendBridge();
  assert.equal(outcome.listenerReturn, true);
  assert.equal(outcome.callbackCount, 1);
  assert.equal(outcome.callbackWasSynchronous, false);
});

test("injects isolated filtering assets on supported SPA route changes", async () => {
  listeners.tabUpdated(19, { url: "https://boardgamegeek.com/thread/1/article/2" });
  await settle();
  assert.deepEqual(calls.cssInsertions, [{ target: { tabId: 19, frameIds: [0] }, files: ["src/content.css"] }]);
  assert.equal(calls.scriptExecutions[0].world, "ISOLATED");
});

test("does not inject assets on unsupported SPA route changes", async () => {
  listeners.tabUpdated(19, { url: "https://boardgamegeek.com/boardgame/1" });
  await settle();
  assert.deepEqual(calls.events, ["stop:19", "deactivate:19", "remove-css:19"]);
  assert.deepEqual(calls.cssRemovals, [{
    target: { tabId: 19, frameIds: [0] }, files: ["src/content.css"]
  }]);
});

test("tab removal clears controllers, queued routes, and mutation relay registrations", async () => {
  const removed = validSender({ tab: { id: 94 }, documentId: "removed-document" });
  let removedFetchStarted;
  const fetchStarted = new Promise((resolve) => { removedFetchStarted = resolve; });
  fetchHandler = (_url, options) => new Promise((_resolve, reject) => {
    removedFetchStarted();
    options.signal.addEventListener("abort", () => reject(Object.assign(
      new Error("cancelled"), { name: "AbortError" }
    )), { once: true });
  });
  const removedPending = sendBridge(validMessage(), removed);
  await fetchStarted;

  let firstRoute = true;
  cssInsertionHandler = () => {
    if (!firstRoute) return undefined;
    firstRoute = false;
    return new Promise(() => {});
  };
  listeners.tabUpdated(94, { url: "https://boardgamegeek.com/thread/1" });
  await settle();
  assert.equal(calls.cssInsertions.length, 1);

  listeners.tabRemoved(94);
  assert.deepEqual((await removedPending).response, { status: "error", reason: "sync-cancelled" });
  listeners.tabUpdated(94, { url: "https://boardgamegeek.com/thread/2" });
  await settle();
  assert.equal(calls.cssInsertions.length, 2);

  fetchHandler = defaultFetch;
  assert.equal(listeners.message({
    type: MUTATION_MESSAGE_TYPE, channelNonce: "b".repeat(32)
  }, removed, () => {}), false);
  const next = await sendBridge(validMessage(), validSender({ tab: { id: 95 } }));
  assert.equal(next.response.status, "ready");
  assert.equal(calls.fetches.filter((call) => call.method === "PUT").length, 2);
});

test("leaving scope aborts tab sync before tearing down both worlds", async () => {
  let fetchStarted;
  const started = new Promise((resolve) => { fetchStarted = resolve; });
  fetchHandler = (_url, options) => new Promise((_resolve, reject) => {
    fetchStarted();
    options.signal.addEventListener("abort", () => {
      calls.events.push("abort:19");
      reject(Object.assign(new Error("cancelled"), { name: "AbortError" }));
    }, { once: true });
  });
  const pending = sendBridge();
  await started;
  listeners.tabUpdated(19, { url: "https://boardgamegeek.com/boardgame/1" });
  assert.deepEqual((await pending).response, { status: "error", reason: "sync-cancelled" });
  await settle();
  assert.ok(calls.events.indexOf("abort:19") < calls.events.indexOf("stop:19"));
  assert.ok(calls.events.indexOf("stop:19") < calls.events.indexOf("deactivate:19"));
  assert.ok(calls.events.indexOf("deactivate:19") < calls.events.indexOf("remove-css:19"));
});

test("leaving scope while MAIN capture is pending rejects the stale result", async () => {
  let releaseCapture;
  const capturePending = new Promise((resolve) => { releaseCapture = resolve; });
  injectionResult = async (options) => {
    await capturePending;
    return [{
      frameId: 0,
      documentId: options.target.documentIds[0],
      result: readyResult()
    }];
  };
  const pending = sendBridge();
  await settle();
  listeners.tabUpdated(19, { url: "https://boardgamegeek.com/boardgame/1" });
  releaseCapture();
  assert.deepEqual((await pending).response, { status: "error", reason: "stale-document" });
  await settle();
  assert.equal(calls.fetches.length, 0);
  assert.ok(stopExecutions().some((call) =>
    call.target.documentIds?.[0]?.startsWith("document-")
  ));
});

test("stale-route cleanup cannot retain FIFO when its exact stop never resolves", async () => {
  const stale = validSender({ tab: { id: 111 }, documentId: "stale-route-cleanup" });
  const later = validSender({ tab: { id: 112 }, documentId: "after-stale-route" });
  let releaseCapture;
  const captureGate = new Promise((resolve) => { releaseCapture = resolve; });
  injectionResult = async (options) => {
    if (options.target.documentIds[0] === stale.documentId) await captureGate;
    return [{ frameId: 0, documentId: options.target.documentIds[0], result: readyResult() }];
  };
  stopExecutionHandler = (options) => options.target.documentIds?.[0] === stale.documentId
    ? new Promise(() => {}) : undefined;

  const stalePending = sendBridge(validMessage(), stale);
  await settle();
  listeners.tabUpdated(stale.tab.id, { status: "loading" });
  releaseCapture();
  assert.deepEqual((await stalePending).response,
    { status: "error", reason: "stale-document" });
  assert.equal((await sendBridge(validMessage(), later)).response.status, "ready");
  assert.ok(stopExecutions().some((call) =>
    call.target.documentIds?.[0] === stale.documentId));
  assert.ok(calls.fetches.some((call) => call.headers.Authorization === TOKEN));
  assert.equal(persisted().length, 1);
});

test("authorization-change cleanup cannot retain FIFO when its exact stop never resolves", async () => {
  const changed = validSender({ tab: { id: 113 }, documentId: "changed-auth-cleanup" });
  const later = validSender({ tab: { id: 114 }, documentId: "after-changed-auth" });
  let fetchStarted;
  const started = new Promise((resolve) => { fetchStarted = resolve; });
  fetchHandler = (_url, options) => new Promise((_resolve, reject) => {
    fetchStarted();
    options.signal.addEventListener("abort", () => reject(Object.assign(
      new Error("cancelled"), { name: "AbortError" }
    )), { once: true });
  });
  stopExecutionHandler = (options) => options.target.documentIds?.[0] === changed.documentId
    ? new Promise(() => {}) : undefined;

  const changedPending = sendBridge(validMessage(), changed);
  await started;
  listeners.storageChanged({ [OPTIONS_KEY]: { oldValue: {}, newValue: {} } }, "local");
  assert.deepEqual((await changedPending).response,
    { status: "error", reason: "authorization-changed" });
  fetchHandler = defaultFetch;
  assert.equal((await sendBridge(validMessage(), later)).response.status, "ready");
  assert.ok(stopExecutions().some((call) =>
    call.target.documentIds?.[0] === changed.documentId));
  assert.ok(calls.fetches.some((call) => call.headers.Authorization === TOKEN));
  assert.equal(persisted().length, 1);
});

test("supported re-entry waits for teardown and reinjects in order", async () => {
  listeners.tabUpdated(19, { url: "https://boardgamegeek.com/boardgame/1" });
  listeners.tabUpdated(19, { url: "https://boardgamegeek.com/thread/2" });
  await settle();
  assert.deepEqual(calls.events, [
    "stop:19", "deactivate:19", "remove-css:19", "insert-css:19", "inject-isolated:19"
  ]);
});

test("isolated teardown stops and deletes the page mutation relay", async () => {
  let relayStops = 0;
  let contentStops = 0;
  globalThis.__bggHardBlockerMutationRelay = () => { relayStops += 1; };
  globalThis.__bggHardBlockerContentStop = () => { contentStops += 1; };
  listeners.tabUpdated(19, { url: "https://boardgamegeek.com/boardgame/1" });
  await settle();
  const isolatedStop = calls.scriptExecutions.find((call) => call.world === "ISOLATED" && call.func);
  isolatedStop.func();
  assert.equal(relayStops, 1);
  assert.equal(contentStops, 1);
  assert.equal(Object.hasOwn(globalThis, "__bggHardBlockerMutationRelay"), false);
  delete globalThis.__bggHardBlockerContentStop;
});

for (const key of [CONSENT_KEY, OPTIONS_KEY]) {
  test(`stops tabs before reload when ${key} changes`, async () => {
    stored[PROFILE_CACHE_KEY] = { 1: { username: "Alice", updatedAt: Date.now() } };
    stored[SUBSCRIPTION_STATE_KEY] = { state: "synced" };
    listeners.storageChanged({ [key]: { oldValue: undefined, newValue: {} } }, "local");
    await settle();
    assert.deepEqual(calls.reloads.map((call) => call.tabId), [7, 11]);
    for (const id of [7, 11]) {
      assert.ok(calls.events.indexOf("remove-derived") < calls.events.indexOf(`stop:${id}`));
      assert.ok(calls.events.indexOf(`stop:${id}`) < calls.events.indexOf(`reload:${id}`));
    }
    assert.equal(Object.hasOwn(stored, PROFILE_CACHE_KEY), false);
    assert.equal(Object.hasOwn(stored, SUBSCRIPTION_STATE_KEY), false);
  });
}

for (const key of [PROFILE_CACHE_KEY, SUBSCRIPTION_STATE_KEY]) {
  test(`ignores ${key} writes`, async () => {
    listeners.storageChanged({ [key]: { newValue: {} } }, "local");
    await settle();
    assert.equal(calls.queries.length, 0);
    assert.equal(calls.reloads.length, 0);
  });
}

test("ignores consent changes outside local storage", async () => {
  listeners.storageChanged({ [CONSENT_KEY]: { newValue: {} } }, "sync");
  await settle();
  assert.equal(calls.queries.length, 0);
});

test("opens onboarding when current consent is absent", async () => {
  stored = {};
  await listeners.installed();
  assert.deepEqual(calls.createdTabs, [{ url: "chrome-extension://test/src/onboarding.html" }]);
});

test("does not reopen onboarding with current consent", async () => {
  await listeners.installed();
  assert.equal(calls.createdTabs.length, 0);
});

test("install removes unversioned content state before refreshing tabs", async () => {
  stored[CONTENT_STATE_KEY] = { usernames: ["Forged Legacy User"] };
  await listeners.installed();
  assert.equal(Object.hasOwn(stored, CONTENT_STATE_KEY), false);
  assert.ok(calls.events.indexOf("remove-derived") < calls.events.indexOf("stop:7"));
});

test("install preserves current schema content state", async () => {
  stored[CONTENT_STATE_KEY] = { schemaVersion: 1, usernames: ["Alice"] };
  await listeners.installed();
  assert.deepEqual(stored[CONTENT_STATE_KEY], { schemaVersion: 1, usernames: ["Alice"] });
});

for (const legacyValue of [null, false, 0]) {
  test(`install removes falsy legacy content state ${String(legacyValue)}`, async () => {
    stored[CONTENT_STATE_KEY] = legacyValue;
    await listeners.installed();
    assert.equal(Object.hasOwn(stored, CONTENT_STATE_KEY), false);
  });
}

test("consent migration removes legacy content state but option changes preserve current state", async () => {
  stored[CONTENT_STATE_KEY] = { usernames: ["Forged Legacy User"] };
  listeners.storageChanged({ [CONSENT_KEY]: { oldValue: undefined, newValue: currentConsent } }, "local");
  await settle();
  assert.equal(Object.hasOwn(stored, CONTENT_STATE_KEY), false);

  reset();
  stored[CONTENT_STATE_KEY] = { schemaVersion: 1, usernames: ["Alice"] };
  listeners.storageChanged({ [OPTIONS_KEY]: { oldValue: {}, newValue: {} } }, "local");
  await settle();
  assert.deepEqual(stored[CONTENT_STATE_KEY], { schemaVersion: 1, usernames: ["Alice"] });
});

(async () => {
  let passed = 0;
  for (const { name, body } of tests) {
    reset();
    try { await body(); passed += 1; }
    catch (error) { error.message = `${name}: ${error.message}`; throw error; }
  }
  console.log(`background: PASS (${passed} tests)`);
})().catch((error) => { console.error(error); process.exitCode = 1; });
