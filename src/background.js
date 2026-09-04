// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Terwox
"use strict";

if (typeof importScripts === "function") importScripts("page-bridge.js");

const CONSENT_KEY = "bggHardBlockerConsent";
const OPTIONS_KEY = "bggHardBlockerOptions";
const PROFILE_CACHE_KEY = "bggHardBlockerProfileCache";
const PROFILE_CACHE_SCHEMA_VERSION = 2;
const SUBSCRIPTION_STATE_KEY = "bggHardBlockerSubscriptionState";
const CONTENT_STATE_KEY = "bggHardBlockerState";
const CONTENT_STATE_SCHEMA_VERSION = 3;
const BRIDGE_MESSAGE_TYPE = "bgg-hard-blocker:initialize-bridge:v1";
const STATUS_MESSAGE_TYPE = "bgg-hard-blocker:update-content-status:v1";
const MUTATION_MESSAGE_TYPE = "bgg-hard-blocker:native-userblock-mutation:v1";
const API_ORIGIN = "https://api.geekdo.com";
const API_ROOT = `${API_ORIGIN}/api`;
const PROFILE_CACHE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const PROFILE_REQUEST_CONCURRENCY = 6;
const MAX_BLOCKED_USERS = 5000;
const MAX_PAGINATION_PAGES = 100;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
// One sync can resolve 5,000 small profiles, but cannot aggregate unbounded API traffic.
const MAX_SYNC_REQUESTS = 6000;
const MAX_SYNC_RESPONSE_BYTES = 16 * 1024 * 1024;
// Relay/capture gets 5 seconds; FIFO wait plus trusted sync share a subsequent 20-second deadline.
const MAIN_CAPTURE_DEADLINE_MS = 5000;
const SYNC_DEADLINE_MS = 20000;
const RECENT_AUTHORIZATION_MAX_AGE_MS = 5000;

const LOADED_EXTENSION_VERSION = chrome.runtime.getManifest?.().version || "";
const DISCLOSURE_VERSION = /^0\.3\.[0-2]$/.test(LOADED_EXTENSION_VERSION) ? "2026-08-04"
  : /^0\.3\.[3-5]$/.test(LOADED_EXTENSION_VERSION) ? "2026-08-05"
    : /^0\.3\.(?:[6-9]|1[0-2])$/.test(LOADED_EXTENSION_VERSION) ? "2026-08-06"
      : /^0\.3\.1[34]$/.test(LOADED_EXTENSION_VERSION) ? "2026-08-10"
        : /^0\.3\.15$/.test(LOADED_EXTENSION_VERSION) ? "2026-08-13"
          : /^0\.4\.[0-3]$/.test(LOADED_EXTENSION_VERSION) || !LOADED_EXTENSION_VERSION
            ? "2026-08-15" : "2026-09-03";

const DISCUSSION_TAB_PATTERNS = [
  "https://boardgamegeek.com/forum/*", "https://boardgamegeek.com/thread/*",
  "https://boardgamegeek.com/geeklist/*", "https://boardgamegeek.com/image/*",
  "https://boardgamegeek.com/video/*", "https://boardgamegeek.com/filepage/*",
  "https://boardgamegeek.com/blog/*/blogpost/*",
  "https://boardgamegeek.com/subscriptions", "https://boardgamegeek.com/subscriptions/"
];
const DISCUSSION_PATH_PATTERNS = [
  /^\/forum\//, /^\/thread\//, /^\/geeklist\//, /^\/image\//, /^\/video\//,
  /^\/filepage\//, /^\/blog\/[^/]+\/blogpost\//, /^\/subscriptions\/?$/
];

class AuthorizationChangedError extends Error {}
class MainCaptureTimeoutError extends Error {}
class SyncBudgetExceededError extends Error {}

function installNativeMutationRevocationRelay(configuration) {
  const nonce = String(configuration?.channelNonce || "");
  if (!/^[a-f0-9]{32}$/.test(nonce)) return;
  const key = "__bggHardBlockerMutationRelay";
  globalThis[key]?.();
  const eventName = `bgg-hard-blocker:native-userblock-mutation:${nonce}`;
  const listener = () => {
    chrome.runtime.sendMessage({
      type: "bgg-hard-blocker:native-userblock-mutation:v1", channelNonce: nonce
    }).catch(() => {});
  };
  document.addEventListener(eventName, listener);
  globalThis[key] = () => document.removeEventListener(eventName, listener);
}

function abortError() {
  const error = new Error("Synchronization cancelled");
  error.name = "AbortError";
  return error;
}
function isAbortError(error) { return error?.name === "AbortError"; }

function isDiscussionUrl(urlText) {
  try {
    const url = new URL(urlText);
    return url.origin === "https://boardgamegeek.com" && !url.username && !url.password &&
      DISCUSSION_PATH_PATTERNS.some((pattern) => pattern.test(url.pathname));
  } catch (_error) { return false; }
}

function hasCurrentConsent(consent) {
  return consent?.granted === true && consent?.disclosureVersion === DISCLOSURE_VERSION;
}

function normalizeUserId(value) {
  const id = String(value ?? "");
  return /^[1-9]\d{0,15}$/.test(id) ? id : "";
}

function normalizeUsername(value) {
  if (typeof value !== "string") return "";
  const username = value.trim();
  return username && username.length <= 128 && !/[\u0000-\u001f\u007f]/.test(username)
    ? username : "";
}

function normalizeAvatarId(value) {
  if (value === "") return "";
  if (typeof value !== "string") return null;
  const normalized = value.toLocaleLowerCase("en-US");
  return /^avatar_(?:id)?[1-9]\d{0,15}\.(?:gif|jpe?g|png|webp)$/.test(normalized)
    ? normalized : null;
}

function avatarIdFromProfile(profile) {
  const urls = profile?.avatar?.urls;
  if (!urls || typeof urls !== "object" || Array.isArray(urls)) return "";
  for (const value of Object.values(urls)) {
    if (typeof value !== "string" || !value || value.length > 8192) continue;
    let decoded = value;
    for (let pass = 0; pass < 3; pass += 1) {
      try {
        const next = decodeURIComponent(decoded);
        if (next === decoded) break;
        decoded = next;
      } catch (_error) { break; }
    }
    const match = decoded.match(
      /\/avatars\/[^?#\s]*?(avatar_(?:id)?[1-9]\d{0,15}\.(?:gif|jpe?g|png|webp))(?:[?#\s]|$)/i
    );
    if (match) return match[1].toLocaleLowerCase("en-US");
  }
  return "";
}

function normalizeAuthorization(value) {
  return typeof value === "string" && value.length > 9 && value.length <= 8192 &&
    value.startsWith("GeekAuth ") && value === value.trim() &&
    !/[\u0000-\u001f\u007f]/.test(value) ? value : "";
}

function normalizeUserIds(value) {
  if (!Array.isArray(value) || value.length > MAX_BLOCKED_USERS) {
    throw new Error("BGG returned an invalid block list");
  }
  const ids = [];
  const seen = new Set();
  for (const rawId of value) {
    const id = normalizeUserId(rawId);
    if (!id) throw new Error("BGG returned an invalid user identifier");
    if (!seen.has(id)) { seen.add(id); ids.push(id); }
  }
  return ids;
}

function sanitizeProfileCache(rawCache, currentIds, now = Date.now()) {
  const cache = {};
  if (!rawCache || typeof rawCache !== "object" || Array.isArray(rawCache)) return cache;
  for (const id of currentIds) {
    const entry = rawCache[id];
    const username = normalizeUsername(entry?.username);
    const avatarId = normalizeAvatarId(entry?.avatarId);
    const updatedAt = Number(entry?.updatedAt);
    if (username && avatarId !== null && Number.isFinite(updatedAt) && updatedAt <= now &&
        now - updatedAt < PROFILE_CACHE_MAX_AGE_MS) {
      cache[id] = { username, avatarId, updatedAt };
    }
  }
  return cache;
}

function readProfileCache(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      value.schemaVersion !== PROFILE_CACHE_SCHEMA_VERSION ||
      !value.profiles || typeof value.profiles !== "object" || Array.isArray(value.profiles)) {
    return {};
  }
  return value.profiles;
}

function writeProfileCache(profiles) {
  return { schemaVersion: PROFILE_CACHE_SCHEMA_VERSION, profiles };
}

async function readAuthorizationSnapshot() {
  const stored = await chrome.storage.local.get([CONSENT_KEY, OPTIONS_KEY, PROFILE_CACHE_KEY]);
  return {
    consent: stored?.[CONSENT_KEY],
    linkSubscriptionBlocks: stored?.[OPTIONS_KEY]?.linkSubscriptionBlocks !== false,
    profileCache: readProfileCache(stored?.[PROFILE_CACHE_KEY])
  };
}

function sameAuthorizationSnapshot(left, right) {
  return JSON.stringify(left.consent) === JSON.stringify(right.consent) &&
    left.linkSubscriptionBlocks === right.linkSubscriptionBlocks;
}

async function assertStillAuthorized(initial, signal) {
  if (signal.aborted) throw abortError();
  const current = await readAuthorizationSnapshot();
  if (signal.aborted) throw abortError();
  if (!hasCurrentConsent(current.consent) || !sameAuthorizationSnapshot(initial, current)) {
    throw new AuthorizationChangedError("Extension authorization changed");
  }
}

async function removeExactPersistedResult(writtenValues, writtenContentState = null) {
  if (!writtenValues && !writtenContentState) return;
  try {
    const current = await chrome.storage.local.get([
      PROFILE_CACHE_KEY, SUBSCRIPTION_STATE_KEY, CONTENT_STATE_KEY
    ]);
    const keys = [];
    if (writtenValues && JSON.stringify(current?.[PROFILE_CACHE_KEY]) ===
        JSON.stringify(writtenValues[PROFILE_CACHE_KEY])) keys.push(PROFILE_CACHE_KEY);
    if (writtenValues && JSON.stringify(current?.[SUBSCRIPTION_STATE_KEY]) ===
        JSON.stringify(writtenValues[SUBSCRIPTION_STATE_KEY])) keys.push(SUBSCRIPTION_STATE_KEY);
    const currentContentState = current?.[CONTENT_STATE_KEY];
    if (writtenContentState &&
        typeof writtenContentState.canonicalWriteId === "string" &&
        currentContentState?.canonicalWriteId === writtenContentState.canonicalWriteId) {
      keys.push(CONTENT_STATE_KEY);
    }
    if (keys.length) await chrome.storage.local.remove(keys);
  } catch (_error) {
    // A storage-area change also removes derived state. This is a best-effort
    // compare-and-remove fallback for a write that raced that change.
  }
}

function assertAllowedApiRequest(url, method) {
  if (url.origin !== API_ORIGIN || url.username || url.password || url.hash) {
    throw new Error("Refused a non-BGG API destination");
  }
  if (method === "GET" && url.pathname === "/api/userblock" && !url.search) return;
  if (method === "GET" && /^\/api\/user\/[1-9]\d{0,15}$/.test(url.pathname) && !url.search) return;
  if (method === "PUT" && /^\/api\/user\/[1-9]\d{0,15}\/blocks$/.test(url.pathname) && !url.search) return;
  if (method === "GET" && url.pathname === "/api/blocks") {
    const keys = [...url.searchParams.keys()];
    const allowed = new Set(["type", "singular", "page", "pageid"]);
    const numeric = (key) => !url.searchParams.has(key) || /^[1-9]\d{0,15}$/.test(url.searchParams.get(key));
    if (keys.every((key) => allowed.has(key)) && new Set(keys).size === keys.length &&
        url.searchParams.get("type") === "user" && url.searchParams.get("singular") === "1" &&
        numeric("page") && numeric("pageid") &&
        !(url.searchParams.has("page") && url.searchParams.has("pageid"))) return;
  }
  throw new Error("Refused an unexpected BGG API request");
}

function consumeSyncResponseBytes(budget, byteLength) {
  if (budget.responseBytes + byteLength > MAX_SYNC_RESPONSE_BYTES) {
    throw new SyncBudgetExceededError("BGG API sync response budget exceeded");
  }
  budget.responseBytes += byteLength;
}

async function readJsonResponse(response, budget) {
  const declared = Number(response.headers?.get?.("content-length"));
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
    throw new Error("BGG API response exceeded the safety limit");
  }
  if (Number.isFinite(declared) && budget.responseBytes + declared > MAX_SYNC_RESPONSE_BYTES) {
    throw new SyncBudgetExceededError("BGG API sync response budget exceeded");
  }
  let bytes;
  if (typeof response.body?.getReader === "function") {
    const reader = response.body.getReader();
    const chunks = [];
    let byteLength = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      byteLength += value.byteLength;
      if (byteLength > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new Error("BGG API response exceeded the safety limit");
      }
      try { consumeSyncResponseBytes(budget, value.byteLength); }
      catch (error) { await reader.cancel(); throw error; }
      chunks.push(value);
    }
    bytes = new Uint8Array(byteLength);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
  } else {
    bytes = typeof response.arrayBuffer === "function"
      ? new Uint8Array(await response.arrayBuffer())
      : new TextEncoder().encode(await response.text());
  }
  if (bytes.byteLength > MAX_RESPONSE_BYTES) {
    throw new Error("BGG API response exceeded the safety limit");
  }
  if (typeof response.body?.getReader !== "function") {
    consumeSyncResponseBytes(budget, bytes.byteLength);
  }
  const text = new TextDecoder().decode(bytes);
  return text ? JSON.parse(text) : null;
}

async function fetchApi(url, method, authorization, signal, budget) {
  assertAllowedApiRequest(url, method);
  if (signal.aborted) throw abortError();
  if (budget.requests >= MAX_SYNC_REQUESTS) {
    throw new SyncBudgetExceededError("BGG API sync request budget exceeded");
  }
  budget.requests += 1;
  const response = await fetch(url.href, {
    method,
    headers: { Accept: "application/json", Authorization: authorization },
    body: method === "PUT" ? "" : undefined,
    cache: "no-store", credentials: "omit", redirect: "error", signal
  });
  if (signal.aborted) throw abortError();
  if (response.redirected) throw new Error("BGG API redirect refused");
  if (!response.ok) throw new Error(`BGG API request failed with HTTP ${response.status}`);
  return response.status === 204 ? null : readJsonResponse(response, budget);
}

function apiUrl(path) { return new URL(path, `${API_ROOT}/`); }

function normalizePaginationLink(value) {
  const url = new URL(String(value || ""), `${API_ROOT}/`);
  assertAllowedApiRequest(url, "GET");
  if (url.pathname !== "/api/blocks") {
    throw new Error("BGG returned an invalid subscription pagination link");
  }
  return url;
}

async function resolveBlockedProfiles(userIds, rawCache, authorization, signal, budget) {
  const now = Date.now();
  const cached = sanitizeProfileCache(rawCache, userIds, now);
  const profileCache = { ...cached };
  const names = new Array(userIds.length);
  const avatars = new Array(userIds.length);
  let cursor = 0;
  let unresolvedCount = 0;
  async function worker() {
    while (cursor < userIds.length) {
      const index = cursor++;
      const id = userIds[index];
      if (signal.aborted) throw abortError();
      if (cached[id]) {
        names[index] = cached[id].username;
        avatars[index] = cached[id].avatarId;
        continue;
      }
      try {
        const profile = await fetchApi(apiUrl(`user/${id}`), "GET", authorization, signal, budget);
        const username = normalizeUsername(profile?.username);
        if (username) {
          const avatarId = avatarIdFromProfile(profile);
          names[index] = username;
          avatars[index] = avatarId;
          profileCache[id] = { username, avatarId, updatedAt: now };
        } else unresolvedCount += 1;
      } catch (error) {
        if (isAbortError(error) || error instanceof SyncBudgetExceededError) throw error;
        unresolvedCount += 1;
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(PROFILE_REQUEST_CONCURRENCY, userIds.length) }, worker));
  if (signal.aborted) throw abortError();
  const seen = new Set();
  const usernames = names.filter((name) => {
    if (!name) return false;
    const key = name.toLocaleLowerCase("en-US");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).sort((a, b) => a.localeCompare(b));
  const avatarIds = [...new Set(avatars.filter(Boolean))].sort();
  return { usernames, avatarIds, unresolvedCount, profileCache };
}

function validateSubscriptionPage(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload) ||
      !Array.isArray(payload.feeds) || !Array.isArray(payload.links) ||
      payload.feeds.length > MAX_BLOCKED_USERS ||
      payload.links.length > MAX_PAGINATION_PAGES) {
    throw new Error("BGG returned an invalid subscription response");
  }
  const ids = [];
  for (const feed of payload.feeds) {
    if (!feed || typeof feed !== "object" || Array.isArray(feed) ||
        !feed.item || typeof feed.item !== "object" || Array.isArray(feed.item) ||
        feed.item.type !== "user") {
      throw new Error("BGG returned an invalid subscription entry");
    }
    const id = normalizeUserId(feed.item.id);
    if (!id) throw new Error("BGG returned an invalid subscription identifier");
    ids.push(id);
  }
  let next = "";
  for (const link of payload.links) {
    if (!link || typeof link !== "object" || Array.isArray(link) ||
        typeof link.rel !== "string" || !link.rel || link.rel.length > 64 ||
        /[\u0000-\u001f\u007f]/.test(link.rel) ||
        typeof link.uri !== "string" || !link.uri || link.uri.length > 2048 ||
        /[\u0000-\u001f\u007f]/.test(link.uri)) {
      throw new Error("BGG returned an invalid subscription link");
    }
    if (link.rel === "next") {
      if (next) throw new Error("BGG returned ambiguous subscription pagination");
      next = link.uri;
    }
  }
  return { ids, next };
}

async function fetchSubscriptionBlockedIds(authorization, signal, budget) {
  const blocked = new Set();
  const visited = new Set();
  let url = apiUrl("blocks?type=user&singular=1");
  for (let page = 0; url; page += 1) {
    if (page >= MAX_PAGINATION_PAGES || visited.has(url.href)) {
      throw new Error("BGG subscription pagination exceeded the safety limit");
    }
    visited.add(url.href);
    const payload = await fetchApi(url, "GET", authorization, signal, budget);
    const pageResult = validateSubscriptionPage(payload);
    for (const id of pageResult.ids) {
      blocked.add(id);
      if (blocked.size > MAX_BLOCKED_USERS) {
        throw new Error("BGG returned too many subscription blocks");
      }
    }
    url = pageResult.next ? normalizePaginationLink(pageResult.next) : null;
  }
  return blocked;
}

async function reconcileSubscriptionBlocks(userIds, initial, authorization, signal, generation, budget) {
  const hiddenIds = [...new Set(userIds)];
  const startingLinkingEpoch = linkingEpoch;
  const deferredState = () => ({
    enabled: true, state: "error", hiddenCount: hiddenIds.length,
    subscriptionBlockedCount: null, addedCount: 0, failedCount: hiddenIds.length,
    deferred: true, syncedAt: new Date().toISOString()
  });
  try {
    const blocked = await fetchSubscriptionBlockedIds(authorization, signal, budget);
    if (linkingEpoch !== startingLinkingEpoch) return deferredState();
    if (linkingSuspended) {
      if (generation <= linkingSuspendedThroughGeneration || Date.now() < linkingQuiescentAfter) {
        return deferredState();
      }
      // Only a later trusted session, after quiescence and complete hidden plus
      // subscription enumeration, may resume optional linking.
      linkingSuspended = false;
    }
    let addedCount = 0;
    let failedCount = 0;
    for (const id of hiddenIds.filter((id) => !blocked.has(id))) {
      if (signal.aborted) throw abortError();
      await assertStillAuthorized(initial, signal);
      const currentRaw = await fetchApi(apiUrl("userblock"), "GET", authorization, signal, budget);
      const currentIds = normalizeUserIds(Array.isArray(currentRaw) ? currentRaw : currentRaw?.userIds);
      if (signal.aborted) throw abortError();
      if (linkingEpoch !== startingLinkingEpoch || linkingSuspended) return deferredState();
      if (!currentIds.includes(id)) continue;
      try {
        await fetchApi(apiUrl(`user/${id}/blocks`), "PUT", authorization, signal, budget);
        blocked.add(id);
        addedCount += 1;
      } catch (error) {
        if (isAbortError(error) || error instanceof AuthorizationChangedError ||
            error instanceof SyncBudgetExceededError) throw error;
        failedCount += 1;
      }
    }
    return {
      enabled: true, state: failedCount ? "partial" : "synced", hiddenCount: hiddenIds.length,
      subscriptionBlockedCount: hiddenIds.filter((id) => blocked.has(id)).length,
      addedCount, failedCount, syncedAt: new Date().toISOString()
    };
  } catch (error) {
    if (isAbortError(error) || error instanceof AuthorizationChangedError ||
        error instanceof SyncBudgetExceededError) throw error;
    return {
      enabled: true, state: "error", hiddenCount: hiddenIds.length,
      subscriptionBlockedCount: null, addedCount: 0, failedCount: hiddenIds.length,
      syncedAt: new Date().toISOString()
    };
  }
}

async function performSync(initial, authorization, signal, generation) {
  if (signal.aborted) throw abortError();
  const budget = { requests: 0, responseBytes: 0 };
  await assertStillAuthorized(initial, signal);
  const raw = await fetchApi(apiUrl("userblock"), "GET", authorization, signal, budget);
  const userIds = normalizeUserIds(Array.isArray(raw) ? raw : raw?.userIds);
  const profiles = await resolveBlockedProfiles(userIds, initial.profileCache, authorization, signal,
    budget);
  const subscriptionLinking = initial.linkSubscriptionBlocks
    ? await reconcileSubscriptionBlocks(userIds, initial, authorization, signal, generation, budget)
    : { enabled: false, state: "disabled", hiddenCount: userIds.length,
        subscriptionBlockedCount: null, addedCount: 0, failedCount: 0 };
  return {
    publicResult: { status: "ready", usernames: profiles.usernames, avatarIds: profiles.avatarIds,
      unresolvedCount: profiles.unresolvedCount, syncedAt: new Date().toISOString() },
    profileCache: profiles.profileCache, subscriptionLinking
  };
}

function stopPageBridge() {
  const stop = globalThis.__bggHardBlockerStop;
  if (typeof stop === "function") stop();
}

function stopContentScript() {
  const stopMutationRelay = globalThis.__bggHardBlockerMutationRelay;
  try {
    if (typeof stopMutationRelay === "function") stopMutationRelay();
  } finally {
    delete globalThis.__bggHardBlockerMutationRelay;
    const stop = globalThis.__bggHardBlockerContentStop;
    if (typeof stop === "function") stop();
  }
}

function confirmContentStatusDocument() {
  return true;
}

async function stopBridgeInDocument(tabId, documentId) {
  try {
    await chrome.scripting.executeScript({ target: { tabId, documentIds: [documentId] },
      func: stopPageBridge, world: "MAIN", injectImmediately: true });
  } catch (_error) {}
}

const activeControllers = new Set();
const activeControllersByTab = new Map();
const routeTasks = new Map();
const tabRouteRevisions = new Map();
let authorizationRevision = 0;
let sessionGeneration = 0;
let latestAuthenticatedGeneration = 0;
let authenticatedQueue = Promise.resolve();
let contentStateQueue = Promise.resolve();
let linkingEpoch = 0;
let linkingSuspended = false;
let linkingSuspendedThroughGeneration = 0;
let linkingQuiescentAfter = 0;
const mutationRelaySessions = new Map();
const contentStatusSessions = new Map();
const recentAuthorizations = new Map();
const authorizationWaiters = new Map();

function authorizationDocumentKey(tabId, documentId) {
  return `${tabId}:${documentId}`;
}

function clearObservedAuthorizations(tabId = null) {
  const prefix = tabId === null ? "" : `${tabId}:`;
  for (const [key, record] of recentAuthorizations) {
    if (!prefix || key.startsWith(prefix)) {
      clearTimeout(record.expirationTimer);
      recentAuthorizations.delete(key);
    }
  }
  for (const [key, waiter] of authorizationWaiters) {
    if (!prefix || key.startsWith(prefix)) {
      authorizationWaiters.delete(key);
      waiter.resolve("");
    }
  }
}

function observedAuthorization(details) {
  if (
    details?.initiator !== "https://boardgamegeek.com" ||
    !Number.isInteger(details?.tabId) ||
    details.tabId < 0 ||
    details?.frameId !== 0 ||
    typeof details?.documentId !== "string" ||
    !details.documentId
  ) {
    return;
  }

  let url;
  try {
    url = new URL(details.url);
  } catch (_error) {
    return;
  }
  if (
    url.origin !== API_ORIGIN ||
    url.username ||
    url.password ||
    !(url.pathname === "/api" || url.pathname.startsWith("/api/"))
  ) {
    return;
  }

  const captureRevision = authorizationRevision;
  Promise.all([
    chrome.storage.local.get(CONSENT_KEY),
    chrome.tabs.get(details.tabId)
  ])
    .then(([stored, tab]) => {
      if (
        captureRevision !== authorizationRevision ||
        !hasCurrentConsent(stored?.[CONSENT_KEY]) ||
        (typeof tab?.pendingUrl === "string" && tab.pendingUrl.length > 0) ||
        !isDiscussionUrl(tab?.url)
      ) {
        return;
      }
      const header = Array.isArray(details.requestHeaders)
        ? details.requestHeaders.find(
            (entry) => String(entry?.name || "").toLowerCase() === "authorization"
          )
        : null;
      const authorization = normalizeAuthorization(header?.value);
      if (!authorization) return;
      deliverObservedAuthorization(details, authorization);
    })
    .catch(() => {});
}

function deliverObservedAuthorization(details, authorization) {
  const key = authorizationDocumentKey(details.tabId, details.documentId);
  const waiter = authorizationWaiters.get(key);
  if (waiter) {
    authorizationWaiters.delete(key);
    waiter.resolve(authorization);
    return;
  }

  const previous = recentAuthorizations.get(key);
  if (previous) clearTimeout(previous.expirationTimer);
  const record = {
    authorization,
    capturedAt: Date.now(),
    expirationTimer: 0
  };
  record.expirationTimer = setTimeout(() => {
    if (recentAuthorizations.get(key) === record) recentAuthorizations.delete(key);
  }, RECENT_AUTHORIZATION_MAX_AGE_MS);
  recentAuthorizations.set(key, record);
}

function reserveObservedAuthorization(tabId, documentId) {
  const key = authorizationDocumentKey(tabId, documentId);
  const now = Date.now();
  for (const [candidateKey, record] of recentAuthorizations) {
    if (now - record.capturedAt > RECENT_AUTHORIZATION_MAX_AGE_MS) {
      clearTimeout(record.expirationTimer);
      recentAuthorizations.delete(candidateKey);
    }
  }

  const recent = recentAuthorizations.get(key);
  if (recent) {
    clearTimeout(recent.expirationTimer);
    recentAuthorizations.delete(key);
    return {
      promise: Promise.resolve(recent.authorization),
      cancel() {}
    };
  }

  let resolveAuthorization;
  const promise = new Promise((resolve) => { resolveAuthorization = resolve; });
  authorizationWaiters.set(key, { resolve: resolveAuthorization });
  return {
    promise,
    cancel() {
      if (authorizationWaiters.get(key)?.resolve === resolveAuthorization) {
        authorizationWaiters.delete(key);
      }
    }
  };
}

function clearTabDocumentSessions(tabId) {
  clearObservedAuthorizations(tabId);
  for (const key of mutationRelaySessions.keys()) {
    if (key.startsWith(`${tabId}:`)) mutationRelaySessions.delete(key);
  }
  for (const key of contentStatusSessions.keys()) {
    if (key.startsWith(`${tabId}:`)) {
      contentStatusSessions.delete(key);
    }
  }
}

function validContentStatusSender(message, sender) {
  return Boolean(message?.type === STATUS_MESSAGE_TYPE &&
    /^[a-f0-9]{32}$/.test(String(message.channelNonce || "")) &&
    sender?.id === chrome.runtime.id && Number.isInteger(sender?.tab?.id) &&
    sender?.frameId === 0 && typeof sender?.documentId === "string" &&
    sender.documentId.length > 0 && sender?.documentLifecycle === "active" &&
    sender?.origin === "https://boardgamegeek.com" && isDiscussionUrl(sender?.url));
}

function contentStatusSessionIsCurrent(key, nonce, routeRevision, authRevision) {
  const session = contentStatusSessions.get(key);
  return session?.nonce === nonce && session.routeRevision === routeRevision &&
    session.authorizationRevision === authRevision &&
    (tabRouteRevisions.get(session.tabId) || 0) === routeRevision &&
    authorizationRevision === authRevision;
}

async function registerContentStatusSession(message, sender, routeRevision, authRevision) {
  const tabId = sender.tab.id;
  const key = `${tabId}:${sender.documentId}`;
  const startingRouteRevision = tabRouteRevisions.get(tabId) || 0;
  if (startingRouteRevision !== routeRevision || authorizationRevision !== authRevision) return null;
  try {
    const tab = await chrome.tabs.get(tabId);
    if ((typeof tab.pendingUrl === "string" && tab.pendingUrl.length > 0) ||
        tab.url !== sender.url || !isDiscussionUrl(tab.url)) return null;
    const stored = await chrome.storage.local.get(CONSENT_KEY);
    if (!hasCurrentConsent(stored?.[CONSENT_KEY]) ||
        (tabRouteRevisions.get(tabId) || 0) !== routeRevision ||
        authorizationRevision !== authRevision) return null;
    const confirmations = await chrome.scripting.executeScript({
      target: { tabId, documentIds: [sender.documentId] },
      func: confirmContentStatusDocument,
      world: "ISOLATED",
      injectImmediately: true
    });
    if (!Array.isArray(confirmations) || confirmations.length !== 1 ||
        confirmations[0]?.frameId !== 0 || confirmations[0]?.documentId !== sender.documentId ||
        confirmations[0]?.result !== true) return null;
    const currentTab = await chrome.tabs.get(tabId);
    if ((typeof currentTab.pendingUrl === "string" && currentTab.pendingUrl.length > 0) ||
        currentTab.url !== sender.url || !isDiscussionUrl(currentTab.url) ||
        (tabRouteRevisions.get(tabId) || 0) !== routeRevision ||
        authorizationRevision !== authRevision) return null;
    const session = { nonce: message.channelNonce, tabId, routeRevision,
      authorizationRevision: authRevision };
    contentStatusSessions.set(key, session);
    return session;
  } catch (_error) {
    return null;
  }
}

function enqueueContentStateUpdate(update) {
  const result = contentStateQueue.catch(() => {}).then(update);
  contentStateQueue = result.catch(() => {});
  return result;
}

function normalizeContentStatus(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const integer = (name, maximum = Number.MAX_SAFE_INTEGER) =>
    Number.isSafeInteger(value[name]) && value[name] >= 0 && value[name] <= maximum
      ? value[name] : null;
  const hiddenPosts = integer("hiddenPosts");
  const hiddenQuotes = integer("hiddenQuotes");
  const redactedProfileNames = integer("redactedProfileNames");
  const updatedAt = typeof value.updatedAt === "string" && Number.isFinite(Date.parse(value.updatedAt))
    ? value.updatedAt : "";
  if ([hiddenPosts, hiddenQuotes, redactedProfileNames].includes(null) || !updatedAt) return null;
  return { hiddenPosts, hiddenQuotes, redactedProfileNames, updatedAt };
}

function updateContentStatus(status, sessionIsCurrent = () => true) {
  const normalized = normalizeContentStatus(status);
  if (!normalized) return Promise.resolve(false);
  return enqueueContentStateUpdate(async () => {
    if (!sessionIsCurrent()) return false;
    const startingAuthorizationRevision = authorizationRevision;
    const stored = await chrome.storage.local.get([CONTENT_STATE_KEY, CONSENT_KEY]);
    if (!sessionIsCurrent() || startingAuthorizationRevision !== authorizationRevision ||
        !hasCurrentConsent(stored?.[CONSENT_KEY])) return false;
    const current = stored?.[CONTENT_STATE_KEY];
    if (current?.schemaVersion !== CONTENT_STATE_SCHEMA_VERSION ||
        !Array.isArray(current.usernames) || !Array.isArray(current.avatarIds)) return false;
    const next = {
      ...current,
      status: { ...(current.status && typeof current.status === "object" ? current.status : {}),
        ...normalized }
    };
    if (!sessionIsCurrent()) return false;
    await chrome.storage.local.set({ [CONTENT_STATE_KEY]: next });
    const after = await chrome.storage.local.get([CONTENT_STATE_KEY, CONSENT_KEY]);
    if (!sessionIsCurrent() || startingAuthorizationRevision !== authorizationRevision ||
        !hasCurrentConsent(after?.[CONSENT_KEY])) {
      if (JSON.stringify(after?.[CONTENT_STATE_KEY]) === JSON.stringify(next)) {
        await chrome.storage.local.set({ [CONTENT_STATE_KEY]: current });
      }
      return false;
    }
    return true;
  });
}

function replaceCanonicalContentState(payload, generation, signal) {
  return enqueueContentStateUpdate(async () => {
    if (signal.aborted || generation !== latestAuthenticatedGeneration) return null;
    const stored = await chrome.storage.local.get(CONTENT_STATE_KEY);
    if (signal.aborted || generation !== latestAuthenticatedGeneration) return null;
    const currentStatus = stored?.[CONTENT_STATE_KEY]?.status;
    const next = {
      schemaVersion: CONTENT_STATE_SCHEMA_VERSION,
      canonicalGeneration: generation,
      // Generation numbers restart with the service worker. This random write
      // identity keeps compare-and-remove rollback exact across restarts.
      canonicalWriteId: crypto.randomUUID(),
      usernames: payload.usernames,
      avatarIds: payload.avatarIds,
      status: {
        ...(currentStatus && typeof currentStatus === "object" ? currentStatus : {}),
        blockedCount: payload.usernames.length,
        lastSync: payload.syncedAt,
        source: "live",
        unresolved: payload.unresolvedCount,
        updatedAt: new Date().toISOString()
      }
    };
    try {
      await chrome.storage.local.set({ [CONTENT_STATE_KEY]: next });
    } catch (error) {
      await removeExactPersistedResult(null, next);
      throw error;
    }
    return next;
  });
}

function stopBridgeSessionBestEffort(tabId, documentId) {
  mutationRelaySessions.delete(`${tabId}:${documentId}`);
  void stopBridgeInDocument(tabId, documentId);
}

function reserveAuthenticatedSession() {
  const previous = authenticatedQueue.catch(() => {});
  let releasePromise;
  let released = false;
  const releasedPromise = new Promise((resolve) => { releasePromise = resolve; });
  authenticatedQueue = previous.then(() => releasedPromise);
  return {
    wait: () => previous,
    release() {
      if (!released) { released = true; releasePromise(); }
    }
  };
}

function trackController(tabId, controller) {
  activeControllers.add(controller);
  const controllers = activeControllersByTab.get(tabId) || new Set();
  controllers.add(controller);
  activeControllersByTab.set(tabId, controllers);
}

function untrackController(tabId, controller) {
  activeControllers.delete(controller);
  const controllers = activeControllersByTab.get(tabId);
  if (!controllers) return;
  controllers.delete(controller);
  if (!controllers.size) activeControllersByTab.delete(tabId);
}

function abortTabSyncs(tabId) {
  for (const controller of activeControllersByTab.get(tabId) || []) controller.abort();
}

async function stopAndRefreshDiscussionTabs() {
  const tabs = await chrome.tabs.query({ url: DISCUSSION_TAB_PATTERNS });
  await Promise.allSettled(tabs.filter((tab) => Number.isInteger(tab.id)).map(async (tab) => {
    try {
      await chrome.scripting.executeScript({ target: { tabId: tab.id, frameIds: [0] },
        func: stopPageBridge, world: "MAIN", injectImmediately: true });
    } catch (_error) {}
    await chrome.tabs.reload(tab.id, { bypassCache: true });
  }));
}

async function removeLegacyContentState() {
  const stored = await chrome.storage.local.get(CONTENT_STATE_KEY);
  if (Object.hasOwn(stored || {}, CONTENT_STATE_KEY) &&
      stored[CONTENT_STATE_KEY]?.schemaVersion !== CONTENT_STATE_SCHEMA_VERSION) {
    await chrome.storage.local.remove(CONTENT_STATE_KEY);
  }
}

async function injectDiscussionScripts(tabId) {
  const target = { tabId, frameIds: [0] };
  await chrome.scripting.insertCSS({ target, files: ["src/content.css"] });
  await chrome.scripting.executeScript({ target, files: ["src/content-core.js", "src/content.js"],
    world: "ISOLATED", injectImmediately: true });
}

async function teardownDiscussionScripts(tabId) {
  const target = { tabId, frameIds: [0] };
  try {
    await chrome.scripting.executeScript({ target, func: stopPageBridge,
      world: "MAIN", injectImmediately: true });
  } catch (_error) {}
  try {
    await chrome.scripting.executeScript({ target, func: stopContentScript,
      world: "ISOLATED", injectImmediately: true });
  } catch (_error) {}
  try {
    await chrome.scripting.removeCSS({ target, files: ["src/content.css"] });
  } catch (_error) {}
}

function enqueueRouteTask(tabId, task) {
  const previous = routeTasks.get(tabId) || Promise.resolve();
  const current = previous.catch(() => {}).then(task).catch(() => {});
  routeTasks.set(tabId, current);
  current.finally(() => {
    if (routeTasks.get(tabId) === current) routeTasks.delete(tabId);
  });
}

function validBridgeSender(message, sender) {
  return Boolean(message?.type === BRIDGE_MESSAGE_TYPE &&
    /^[a-f0-9]{32}$/.test(String(message.channelNonce || "")) && sender?.id === chrome.runtime.id &&
    Number.isInteger(sender?.tab?.id) && sender?.frameId === 0 &&
    typeof sender?.documentId === "string" && sender.documentId.length > 0 &&
    sender?.documentLifecycle === "active" && sender?.origin === "https://boardgamegeek.com" &&
    isDiscussionUrl(sender?.url));
}

const bridgeSessions = new Map();

async function runBridgeSession(message, sender, generation, reservation) {
  const tabId = sender.tab.id;
  const documentId = sender.documentId;
  let injectionResults = null;
  let privateResult = null;
  let authorization = "";
  let syncResult = null;
  let writtenValues = null;
  let writtenContentState = null;
  let controller = null;
  let deadline = null;
  let timedOut = false;
  let observedCapture = null;
  const startingAuthorizationRevision = authorizationRevision;
  const startingRouteRevision = tabRouteRevisions.get(tabId) || 0;
  try {
    const tab = await chrome.tabs.get(tabId);
    // A pending target or URL mismatch means this sender document is no longer the tab's exact page.
    if ((typeof tab.pendingUrl === "string" && tab.pendingUrl.length > 0) ||
        tab.url !== sender.url || !isDiscussionUrl(tab.url)) {
      return { status: "error", reason: "stale-document" };
    }
    const initial = await readAuthorizationSnapshot();
    if (!hasCurrentConsent(initial.consent)) return { status: "error", reason: "consent-required" };
    const relayKey = `${tabId}:${documentId}`;
    if ((tabRouteRevisions.get(tabId) || 0) === startingRouteRevision &&
        authorizationRevision === startingAuthorizationRevision) {
      contentStatusSessions.set(relayKey, { nonce: message.channelNonce, tabId,
        routeRevision: startingRouteRevision,
        authorizationRevision: startingAuthorizationRevision });
    }
    mutationRelaySessions.set(relayKey, message.channelNonce);
    let captureDeadline = null;
    let captureExpired = false;
    try {
      observedCapture = reserveObservedAuthorization(tabId, documentId);
      const captureResult = await Promise.race([
        (async () => {
          try {
            await chrome.scripting.executeScript({
              target: { tabId, documentIds: [documentId] },
              func: installNativeMutationRevocationRelay,
              args: [{ channelNonce: message.channelNonce }],
              world: "ISOLATED",
              injectImmediately: true
            });
          } catch (_error) {
            linkingEpoch += 1;
            linkingSuspended = true;
            linkingSuspendedThroughGeneration = sessionGeneration;
            linkingQuiescentAfter = Number.POSITIVE_INFINITY;
          }
          if (captureExpired) throw new MainCaptureTimeoutError();
          injectionResults = await chrome.scripting.executeScript({
            target: { tabId, documentIds: [documentId] }, func: installBggBlockListBridge,
            args: [{ channelNonce: message.channelNonce }], world: "MAIN", injectImmediately: true
          });
          // Chrome can run the injected function twice in one document for a
          // single executeScript call. The duplicate entry replaces the first,
          // which then resolves as "cancelled" — measured 41ms after injection
          // on a live BGG thread, while BGG's first authenticated
          // api.geekdo.com request is ~600ms away. Ending the capture race on
          // that result discarded both the replacement entry still waiting in
          // the page and this session's observed-header fallback, and reported
          // "sync-failed" before any authorization could exist. Only a
          // cancelled entry is treated this way; every other bridge failure is
          // still terminal.
          if (injectionResults?.[0]?.result?.reason === "cancelled") {
            return await new Promise(() => {});
          }
          return { source: "page", injectionResults };
        })(),
        observedCapture.promise.then((observed) => ({ source: "network", observed })),
        new Promise((_resolve, reject) => {
          captureDeadline = setTimeout(() => {
            captureExpired = true;
            reject(new MainCaptureTimeoutError());
          }, MAIN_CAPTURE_DEADLINE_MS);
        })
      ]);
      if (captureResult.source === "network") {
        authorization = normalizeAuthorization(captureResult.observed);
      }
    } finally {
      if (captureDeadline !== null) clearTimeout(captureDeadline);
      observedCapture?.cancel();
    }
    if ((tabRouteRevisions.get(tabId) || 0) !== startingRouteRevision) {
      contentStatusSessions.delete(`${tabId}:${documentId}`);
      stopBridgeSessionBestEffort(tabId, documentId);
      return { status: "error", reason: "stale-document" };
    }
    if (!authorization) {
      if (!Array.isArray(injectionResults) || injectionResults.length !== 1 ||
          injectionResults[0]?.frameId !== 0 || injectionResults[0]?.documentId !== documentId) {
        contentStatusSessions.delete(`${tabId}:${documentId}`);
        stopBridgeSessionBestEffort(tabId, documentId);
        return { status: "error", reason: "stale-document" };
      }
      privateResult = injectionResults[0]?.result;
      if (privateResult?.status !== "ready") {
        stopBridgeSessionBestEffort(tabId, documentId);
        return { status: "error", reason: privateResult?.reason === "authorization-unavailable"
          ? "authorization-unavailable" : "sync-failed" };
      }
      authorization = normalizeAuthorization(privateResult.authorization);
    }
    if (!authorization) {
      stopBridgeSessionBestEffort(tabId, documentId);
      return { status: "error", reason: "sync-failed" };
    }
    latestAuthenticatedGeneration = Math.max(latestAuthenticatedGeneration, generation);
    controller = new AbortController();
    trackController(tabId, controller);
    deadline = setTimeout(() => { timedOut = true; controller.abort(); }, SYNC_DEADLINE_MS);
    await reservation.wait();
    if (controller.signal.aborted) throw abortError();
    await assertStillAuthorized(initial, controller.signal);
    syncResult = await performSync(initial, authorization, controller.signal, generation);
    await assertStillAuthorized(initial, controller.signal);
    if (generation === latestAuthenticatedGeneration) {
      writtenValues = {
        [PROFILE_CACHE_KEY]: writeProfileCache(syncResult.profileCache),
        [SUBSCRIPTION_STATE_KEY]: { ...syncResult.subscriptionLinking, updatedAt: new Date().toISOString() }
      };
      await chrome.storage.local.set(writtenValues);
      await assertStillAuthorized(initial, controller.signal);
      if (generation !== latestAuthenticatedGeneration) {
        await removeExactPersistedResult(writtenValues);
        writtenValues = null;
        return syncResult.publicResult;
      }
      writtenContentState = await replaceCanonicalContentState(
        syncResult.publicResult, generation, controller.signal
      );
      await assertStillAuthorized(initial, controller.signal);
      if (generation !== latestAuthenticatedGeneration) {
        await removeExactPersistedResult(writtenValues, writtenContentState);
        writtenValues = null;
        writtenContentState = null;
      }
    }
    return syncResult.publicResult;
  } catch (error) {
    if (error instanceof MainCaptureTimeoutError) {
      stopBridgeSessionBestEffort(tabId, documentId);
      return { status: "error", reason: "authorization-unavailable" };
    }
    if (error instanceof SyncBudgetExceededError) {
      controller?.abort();
      await removeExactPersistedResult(writtenValues, writtenContentState);
      return { status: "error", reason: "bridge-unavailable" };
    }
    if (error instanceof AuthorizationChangedError) {
      await removeExactPersistedResult(writtenValues, writtenContentState);
      stopBridgeSessionBestEffort(tabId, documentId);
      return { status: "error", reason: "authorization-changed" };
    }
    if (isAbortError(error)) {
      await removeExactPersistedResult(writtenValues, writtenContentState);
      if (!timedOut && authorizationRevision !== startingAuthorizationRevision) {
        stopBridgeSessionBestEffort(tabId, documentId);
        return { status: "error", reason: "authorization-changed" };
      }
      return { status: "error", reason: timedOut ? "sync-timeout" : "sync-cancelled" };
    }
    await removeExactPersistedResult(writtenValues, writtenContentState);
    return { status: "error", reason: "bridge-unavailable" };
  } finally {
    if (deadline !== null) clearTimeout(deadline);
    if (controller) untrackController(tabId, controller);
    authorization = "";
    injectionResults = null;
    privateResult = null;
    syncResult = null;
    writtenValues = null;
    writtenContentState = null;
    observedCapture?.cancel();
    reservation.release();
  }
}

async function initializeBridge(message, sender) {
  if (!validBridgeSender(message, sender)) return { status: "error", reason: "invalid-sender" };
  const key = `${sender.tab.id}:${sender.documentId}`;
  const existing = bridgeSessions.get(key);
  if (existing) return existing;
  const generation = ++sessionGeneration;
  const reservation = reserveAuthenticatedSession();
  const session = runBridgeSession(message, sender, generation, reservation);
  bridgeSessions.set(key, session);
  try { return await session; }
  finally { if (bridgeSessions.get(key) === session) bridgeSessions.delete(key); }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === MUTATION_MESSAGE_TYPE) {
    const valid = sender?.id === chrome.runtime.id && Number.isInteger(sender?.tab?.id) &&
      sender?.frameId === 0 && typeof sender?.documentId === "string" &&
      sender.documentId.length > 0 && sender?.documentLifecycle === "active" &&
      sender?.origin === "https://boardgamegeek.com" && isDiscussionUrl(sender?.url) &&
      /^[a-f0-9]{32}$/.test(String(message.channelNonce || "")) &&
      mutationRelaySessions.get(`${sender.tab.id}:${sender.documentId}`) === message.channelNonce;
    if (valid) {
      linkingEpoch += 1;
      linkingSuspended = true;
      linkingSuspendedThroughGeneration = sessionGeneration;
      linkingQuiescentAfter = Date.now() + 500;
    }
    return false;
  }
  if (message?.type === STATUS_MESSAGE_TYPE) {
    if (!validContentStatusSender(message, sender)) return false;
    const key = `${sender.tab.id}:${sender.documentId}`;
    const routeRevision = tabRouteRevisions.get(sender.tab.id) || 0;
    const authRevision = authorizationRevision;
    const existing = contentStatusSessions.get(key);
    const registered = existing?.nonce === message.channelNonce &&
      contentStatusSessionIsCurrent(key, message.channelNonce, routeRevision, authRevision)
      ? Promise.resolve(existing)
      : registerContentStatusSession(message, sender, routeRevision, authRevision);
    registered
      .then((session) => session ? updateContentStatus(message.status, () =>
        contentStatusSessionIsCurrent(key, message.channelNonce,
          session.routeRevision, session.authorizationRevision)) : false)
      .then((updated) => sendResponse({ status: updated ? "ok" : "ignored" }));
    return true;
  }
  if (message?.type !== BRIDGE_MESSAGE_TYPE) return false;
  initializeBridge(message, sender).then(sendResponse);
  return true;
});

chrome.webRequest.onBeforeSendHeaders.addListener(
  observedAuthorization,
  { urls: [`${API_ROOT}/*`], types: ["xmlhttprequest"] },
  ["requestHeaders", "extraHeaders"]
);

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  let invalidated = false;
  if (changeInfo.status === "loading") {
    tabRouteRevisions.set(tabId, (tabRouteRevisions.get(tabId) || 0) + 1);
    abortTabSyncs(tabId);
    invalidated = true;
    linkingQuiescentAfter = 0;
    clearTabDocumentSessions(tabId);
  }
  if (!changeInfo.url) return;
  if (isDiscussionUrl(changeInfo.url)) {
    enqueueRouteTask(tabId, () => injectDiscussionScripts(tabId));
    return;
  }
  if (!invalidated) {
    tabRouteRevisions.set(tabId, (tabRouteRevisions.get(tabId) || 0) + 1);
    abortTabSyncs(tabId);
  }
  clearTabDocumentSessions(tabId);
  enqueueRouteTask(tabId, () => teardownDiscussionScripts(tabId));
});

chrome.tabs.onRemoved.addListener((tabId) => {
  const controllers = activeControllersByTab.get(tabId);
  for (const controller of controllers || []) {
    controller.abort();
    activeControllers.delete(controller);
  }
  activeControllersByTab.delete(tabId);
  routeTasks.delete(tabId);
  tabRouteRevisions.delete(tabId);
  clearTabDocumentSessions(tabId);
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "local" || (!changes[CONSENT_KEY] && !changes[OPTIONS_KEY])) return;
  if (changes[CONSENT_KEY]) {
    clearObservedAuthorizations();
  }
  authorizationRevision += 1;
  if (changes[CONSENT_KEY]) {
    contentStatusSessions.clear();
  }
  for (const controller of activeControllers) controller.abort();
  const legacyCleanup = changes[CONSENT_KEY] ? removeLegacyContentState() : Promise.resolve();
  legacyCleanup.catch(() => {})
    .then(() => chrome.storage.local.remove([PROFILE_CACHE_KEY, SUBSCRIPTION_STATE_KEY]))
    .catch(() => {})
    .then(() => stopAndRefreshDiscussionTabs())
    .catch(() => {});
});

chrome.runtime.onInstalled.addListener(async () => {
  const stored = await chrome.storage.local.get(CONSENT_KEY);
  await removeLegacyContentState();
  await stopAndRefreshDiscussionTabs();
  if (!hasCurrentConsent(stored?.[CONSENT_KEY])) {
    await chrome.tabs.create({ url: chrome.runtime.getURL("src/onboarding.html") });
  }
});
