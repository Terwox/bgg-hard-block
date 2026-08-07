// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Terwox
//
// This file is part of BGG Hard Block. See the LICENSE file at the repository
// root for the full license text.

/**
 * MAIN-world bridge: obtains the signed-in user's BGG block list.
 *
 * ## Why this file exists
 *
 * BGG's block list is only available from an authenticated endpoint
 * (`api.geekdo.com/api/userblock`). Authentication uses a `GeekAuth` bearer
 * value that BGG's own frontend attaches to its requests. An extension content
 * script in the ISOLATED world cannot see that value, because it lives in the
 * page's JavaScript context.
 *
 * So this script runs in the MAIN world — the same context as BGG's own code —
 * and wraps `fetch` and `XMLHttpRequest` in order to *observe* the header BGG
 * already sends. It does not create credentials, prompt for them, or read them
 * from storage.
 *
 * ## The rule that makes this safe to audit
 *
 * The captured value lives in the module-local `authHeader` variable and is used
 * for exactly one thing: as the `Authorization` header on requests to
 * `API_ROOT`, the same origin BGG's frontend already sends it to.
 *
 * It is never:
 *   - written to `chrome.storage` or `localStorage`
 *   - placed in the DOM
 *   - included in any object passed to `publish()`
 *   - sent anywhere other than `api.geekdo.com`
 *
 * `publish()` is the *only* channel from this file to the rest of the
 * extension, and it serialises its argument into a `<meta>` element that the
 * page itself can read. Anything reaching `publish()` should be treated as
 * public. Confirming that no code path puts `authHeader` into a published
 * payload is the single most useful review of this file.
 *
 * ## World boundary
 *
 * MAIN world (this file)      ISOLATED world (settings-bridge.js, content.js)
 *   holds authHeader            holds chrome.storage access
 *          |                              |
 *          |  <meta id=bgg-hard-blocker-data>  (block list, public usernames)
 *          | ---------------------------> |
 *          |  <meta id=bgg-hard-blocker-settings>  (consent, options)
 *          | <--------------------------- |
 *
 * Both directions carry only non-sensitive data. The page can read both
 * elements; that is accepted, because a signed-in BGG page already knows its own
 * block list.
 *
 * This script is injected only on the discussion URLs listed in
 * `manifest.json` (and, for in-page route changes, by `background.js`).
 */
(function installBggBlockListBridge() {
  "use strict";

  // Chrome can inject the same script twice — once declaratively on cold load,
  // once programmatically after a client-side route change. Re-running would
  // double-wrap fetch/XHR, so each bridge guards on a global flag.
  const INSTALLATION_KEY = "__bggHardBlockerPageBridgeInstalled";
  if (globalThis[INSTALLATION_KEY]) {
    return;
  }
  globalThis[INSTALLATION_KEY] = true;

  /** The only network origin this file ever contacts. */
  const API_ROOT = "https://api.geekdo.com/api";
  /** BGG's bearer scheme. Used to recognise the header, not to construct it. */
  const AUTH_PREFIX = "GeekAuth ";
  const DATA_ELEMENT_ID = "bgg-hard-blocker-data";
  const DATA_EVENT = "bgg-hard-blocker:blocklist";
  const PROFILE_CACHE_KEY = "bgg-hard-blocker-profile-cache-v1";
  const PROFILE_CACHE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
  const SETTINGS_ELEMENT_ID = "bgg-hard-blocker-settings";
  const SETTINGS_EVENT = "bgg-hard-blocker:settings";

  // Captured before the wrappers are installed, so the extension's own requests
  // bypass its own interceptors. Without this, syncBlockList() would observe its
  // own Authorization header and could recurse.
  const originalFetch = window.fetch.bind(window);
  const originalXhrOpen = XMLHttpRequest.prototype.open;
  const originalXhrSetRequestHeader = XMLHttpRequest.prototype.setRequestHeader;
  // WeakMap so that abandoned XHR objects stay garbage-collectable.
  const xhrMetadata = new WeakMap();

  /** The observed `GeekAuth` value. Never leaves this module. See file header. */
  let authHeader = "";
  /** Last value a sync was attempted with, so a re-observed header is a no-op. */
  let attemptedAuthHeader = "";
  /** Mirrors the user's consent state, pushed in from the ISOLATED world. */
  let consentGranted = false;
  let interceptorsInstalled = false;
  let lastBlockListPayload = null;
  /** `null` until settings arrive; `true`/`false` afterwards. The tri-state matters. */
  let linkSubscriptionBlocks = null;
  let subscriptionResyncRequested = false;
  let subscriptionSyncPromise = null;
  let syncPromise = null;
  let resyncRequested = false;

  /**
   * Publish a payload to the ISOLATED world via a `<meta>` element.
   *
   * This is the only outbound channel from the MAIN world. Everything passed
   * here becomes readable by the BGG page, so it must contain only data the page
   * already has: block-list user IDs, public usernames, and sync status.
   *
   * @param {object} payload Non-sensitive data only.
   */
  function publish(payload) {
    let element = document.getElementById(DATA_ELEMENT_ID);
    if (!element) {
      element = document.createElement("meta");
      element.id = DATA_ELEMENT_ID;
      element.setAttribute("name", DATA_ELEMENT_ID);
      document.documentElement.appendChild(element);
    }

    element.setAttribute("content", JSON.stringify(payload));
    document.dispatchEvent(new CustomEvent(DATA_EVENT));
  }

  /**
   * Merge subscription-linking status into the last published payload.
   *
   * Kept separate from `publish` so a linking update cannot accidentally drop
   * the block list the content script is relying on.
   */
  function publishSubscriptionLinking(subscriptionLinking) {
    if (!lastBlockListPayload) {
      return;
    }

    lastBlockListPayload = {
      ...lastBlockListPayload,
      subscriptionLinking
    };
    publish(lastBlockListPayload);
  }

  /** Read the settings element written by `settings-bridge.js`. */
  function readSettingsPayload() {
    const element = document.getElementById(SETTINGS_ELEMENT_ID);
    if (!element) {
      return null;
    }

    try {
      return JSON.parse(element.getAttribute("content") || "null");
    } catch (_error) {
      return null;
    }
  }

  /**
   * Record a `GeekAuth` header seen on one of BGG's own requests.
   *
   * Three guards, in order of importance:
   *   1. `consentGranted` — before the user agrees, nothing is captured at all.
   *   2. header name is `authorization` — case-insensitively.
   *   3. value starts with `GeekAuth ` — so unrelated bearer tokens from any
   *      third-party widget on the page are ignored.
   *
   * The first sync is kicked off from here rather than at load, because the
   * header does not exist until BGG makes its first authenticated request.
   */
  function captureAuthorization(name, value) {
    if (
      !consentGranted ||
      String(name).toLowerCase() !== "authorization" ||
      typeof value !== "string" ||
      !value.startsWith(AUTH_PREFIX)
    ) {
      return;
    }

    authHeader = value;
    // Only sync when the value actually changed. BGG sets this header on most
    // requests, so without this guard every page interaction would re-sync.
    if (attemptedAuthHeader !== value) {
      attemptedAuthHeader = value;
      queueMicrotask(syncBlockList);
    }
  }

  /** Normalise the several shapes `fetch` accepts for headers, then inspect. */
  function inspectHeaders(headers) {
    if (!headers) {
      return;
    }

    try {
      const normalized = new Headers(headers);
      const authorization = normalized.get("authorization");
      if (authorization) {
        captureAuthorization("authorization", authorization);
      }
    } catch (_error) {
      // Invalid headers belong to the host request; let the native fetch report them.
    }
  }

  /**
   * Load the profile ID→username cache.
   *
   * Stored in BGG's own `localStorage` rather than `chrome.storage` because it
   * is derived entirely from public profile data, and keeping it on the BGG
   * origin means clearing site data clears it too.
   */
  function loadProfileCache() {
    try {
      const parsed = JSON.parse(localStorage.getItem(PROFILE_CACHE_KEY) || "{}");
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch (_error) {
      return {};
    }
  }

  function saveProfileCache(cache) {
    try {
      localStorage.setItem(PROFILE_CACHE_KEY, JSON.stringify(cache));
    } catch (_error) {
      // Blocking still works for this page if site storage is unavailable.
    }
  }

  /**
   * The single choke point for every network request this extension makes.
   *
   * Auditing note: `credentials: "omit"` is deliberate. The request carries the
   * explicit `Authorization` header and nothing else — no cookies ride along, so
   * this cannot become an ambient-authority request against some other endpoint.
   * `cache: "no-store"` keeps a stale block list from being served back.
   *
   * @param {string} url Must be under `API_ROOT`; callers construct it from there.
   * @param {string} authorization The observed `GeekAuth` value.
   */
  async function fetchApi(url, authorization, init = {}) {
    const response = await originalFetch(url, {
      method: init.method || "GET",
      headers: {
        Accept: "application/json",
        Authorization: authorization,
        ...(init.headers || {})
      },
      body: init.body,
      cache: "no-store",
      credentials: "omit"
    });

    if (!response.ok) {
      throw new Error(`BGG API returned ${response.status} for ${url}`);
    }

    if (response.status === 204) {
      return null;
    }

    const text = await response.text();
    return text ? JSON.parse(text) : null;
  }

  function fetchJson(url, authorization) {
    return fetchApi(url, authorization);
  }

  /**
   * Turn blocked user IDs into usernames, which is what the DOM filter matches on.
   *
   * BGG's block list returns numeric IDs, but posts are attributed by username,
   * so a lookup is unavoidable. Results are cached for 30 days to avoid
   * re-requesting every profile on every page load.
   *
   * On a failed lookup the code prefers a stale cached username over dropping
   * the user from the list — failing open here would mean showing a post the
   * user asked never to see, which is the worse error.
   *
   * @returns {Promise<{usernames: string[], unresolved: string[]}>}
   */
  async function resolveBlockedProfiles(userIds, authorization) {
    const now = Date.now();
    const cache = loadProfileCache();
    const usernames = [];
    const unresolved = [];
    let cacheChanged = false;

    await Promise.all(
      userIds.map(async (rawId) => {
        const id = String(rawId);
        const cached = cache[id];
        const fresh =
          cached?.username &&
          Number.isFinite(cached.updatedAt) &&
          now - cached.updatedAt < PROFILE_CACHE_MAX_AGE_MS;

        if (fresh) {
          usernames.push(cached.username);
          return;
        }

        try {
          const profile = await fetchJson(`${API_ROOT}/user/${encodeURIComponent(id)}`, authorization);
          if (profile?.username) {
            cache[id] = { username: profile.username, updatedAt: now };
            usernames.push(profile.username);
            cacheChanged = true;
            return;
          }
        } catch (_error) {
          // Prefer a stale name over silently un-blocking someone.
          if (cached?.username) {
            usernames.push(cached.username);
            return;
          }
        }

        unresolved.push(id);
      })
    );

    if (cacheChanged) {
      saveProfileCache(cache);
    }

    return {
      usernames: [...new Set(usernames)].sort((a, b) => a.localeCompare(b)),
      unresolved
    };
  }

  /**
   * Resolve a pagination link and refuse to follow it off-origin.
   *
   * BGG supplies `links[].uri` values for paging through subscription blocks.
   * Following one blindly would let a compromised or malicious API response
   * redirect an authenticated request — carrying the user's `GeekAuth` header —
   * to an attacker-controlled host. This throws instead.
   */
  function normalizeApiLink(uri) {
    const url = new URL(String(uri || ""), `${API_ROOT}/`);
    if (url.origin !== new URL(API_ROOT).origin) {
      throw new Error("BGG returned a subscription pagination link on another origin");
    }
    return url.href;
  }

  /**
   * Page through BGG's user-level subscription blocks.
   *
   * `visited` guards against a server response that points its `next` link back
   * at a page already fetched, which would otherwise loop forever.
   */
  async function fetchSubscriptionBlockedUserIds(authorization) {
    const blocked = new Set();
    const visited = new Set();
    let url = `${API_ROOT}/blocks?type=user&singular=1`;

    while (url && !visited.has(url)) {
      visited.add(url);
      const payload = await fetchJson(url, authorization);

      for (const feed of Array.isArray(payload?.feeds) ? payload.feeds : []) {
        if (feed?.item?.type === "user" && feed.item.id != null) {
          blocked.add(String(feed.item.id));
        }
      }

      const next = Array.isArray(payload?.links)
        ? payload.links.find((link) => link?.rel === "next")?.uri
        : null;
      url = next ? normalizeApiLink(next) : "";
    }

    return blocked;
  }

  /**
   * Add one user-level subscription block at BGG.
   *
   * Note there is deliberately no corresponding remove function anywhere in this
   * codebase. Linking is one-way: turning the option off stops future additions
   * but never undoes past ones, because the extension cannot tell which blocks
   * the user set themselves.
   */
  function addSubscriptionBlock(userId, authorization) {
    return fetchApi(
      `${API_ROOT}/user/${encodeURIComponent(userId)}/blocks`,
      authorization,
      { method: "PUT", body: "" }
    );
  }

  /**
   * Bring BGG's subscription blocks in line with the Hidden Users list.
   *
   * Only additions, only for IDs that are missing. The loop re-checks
   * `linkSubscriptionBlocks` on every iteration so that switching the option off
   * mid-sync stops immediately rather than finishing the batch.
   *
   * Individual failures are counted rather than thrown, so one rejected `PUT`
   * does not abandon the remaining users.
   */
  async function reconcileSubscriptionBlocks(userIds, authorization) {
    const hiddenIds = [...new Set(userIds.map(String))];
    publishSubscriptionLinking({
      enabled: true,
      state: "syncing",
      hiddenCount: hiddenIds.length,
      subscriptionBlockedCount: null,
      addedCount: 0,
      failedCount: 0
    });

    try {
      const subscriptionBlocked = await fetchSubscriptionBlockedUserIds(authorization);
      const missing = hiddenIds.filter((id) => !subscriptionBlocked.has(id));
      let addedCount = 0;
      let failedCount = 0;

      for (const id of missing) {
        // Re-checked every iteration: the user may toggle the option while this
        // loop is still running.
        if (linkSubscriptionBlocks !== true) {
          publishSubscriptionLinking({
            enabled: false,
            state: "disabled",
            hiddenCount: hiddenIds.length,
            subscriptionBlockedCount: subscriptionBlocked.size,
            addedCount,
            failedCount
          });
          return;
        }

        try {
          await addSubscriptionBlock(id, authorization);
          subscriptionBlocked.add(id);
          addedCount += 1;
        } catch (_error) {
          failedCount += 1;
        }
      }

      publishSubscriptionLinking({
        enabled: true,
        state: failedCount ? "partial" : "synced",
        hiddenCount: hiddenIds.length,
        subscriptionBlockedCount: subscriptionBlocked.size,
        addedCount,
        failedCount,
        syncedAt: new Date().toISOString()
      });
    } catch (_error) {
      // Linking is a convenience; discussion filtering is the core feature and
      // keeps working regardless. Report and move on.
      publishSubscriptionLinking({
        enabled: true,
        state: "error",
        hiddenCount: hiddenIds.length,
        subscriptionBlockedCount: null,
        addedCount: 0,
        failedCount: hiddenIds.length,
        syncedAt: new Date().toISOString()
      });
    }
  }

  /**
   * Serialise subscription syncs.
   *
   * At most one reconcile runs at a time. A request arriving mid-flight sets
   * `subscriptionResyncRequested` and is coalesced into a single follow-up run,
   * so rapid block-list edits cannot fan out into overlapping `PUT` storms.
   */
  function queueSubscriptionSync(userIds, authorization, force = false) {
    if (linkSubscriptionBlocks !== true || !authorization) {
      return Promise.resolve();
    }

    if (subscriptionSyncPromise) {
      subscriptionResyncRequested ||= force;
      return subscriptionSyncPromise;
    }

    subscriptionSyncPromise = reconcileSubscriptionBlocks(userIds, authorization)
      .finally(() => {
        subscriptionSyncPromise = null;
        if (subscriptionResyncRequested && lastBlockListPayload) {
          subscriptionResyncRequested = false;
          queueSubscriptionSync(lastBlockListPayload.userIds, authHeader);
        }
      });

    return subscriptionSyncPromise;
  }

  /**
   * Apply consent and options pushed in from the ISOLATED world.
   *
   * This is the gate for the whole file. `installInterceptors()` is called only
   * after consent is confirmed, so before the user agrees this script has not
   * wrapped `fetch`, has not observed a header, and has made no requests.
   *
   * Withdrawing consent clears the captured header immediately.
   */
  function acceptSettingsPayload() {
    const settings = readSettingsPayload();
    if (typeof settings?.consentGranted !== "boolean") {
      return;
    }

    consentGranted = settings.consentGranted;
    if (!consentGranted) {
      authHeader = "";
      attemptedAuthHeader = "";
      linkSubscriptionBlocks = false;
      return;
    }

    installInterceptors();
    linkSubscriptionBlocks = settings.linkSubscriptionBlocks;
    if (!linkSubscriptionBlocks) {
      publishSubscriptionLinking({
        enabled: false,
        state: "disabled",
        hiddenCount: lastBlockListPayload?.userIds?.length ?? null,
        subscriptionBlockedCount: null,
        addedCount: 0,
        failedCount: 0
      });
      return;
    }

    if (lastBlockListPayload && authHeader) {
      queueSubscriptionSync(lastBlockListPayload.userIds, authHeader, true);
    }
  }

  /**
   * Fetch the block list, resolve usernames, and publish the result.
   *
   * Note what the published payload contains: user IDs, public usernames,
   * unresolved IDs, and a timestamp. No authorization value.
   */
  async function performSync(authorization) {
    const rawBlockList = await fetchJson(`${API_ROOT}/userblock`, authorization);
    // BGG has returned both a bare array and an object wrapper here across
    // frontend revisions; accept either rather than breaking on a redeploy.
    const userIds = Array.isArray(rawBlockList)
      ? rawBlockList.map(String)
      : Array.isArray(rawBlockList?.userIds)
        ? rawBlockList.userIds.map(String)
        : [];
    const profiles = await resolveBlockedProfiles(userIds, authorization);

    lastBlockListPayload = {
      status: "ready",
      userIds,
      usernames: profiles.usernames,
      unresolved: profiles.unresolved,
      syncedAt: new Date().toISOString()
    };
    publish(lastBlockListPayload);

    if (linkSubscriptionBlocks === false) {
      publishSubscriptionLinking({
        enabled: false,
        state: "disabled",
        hiddenCount: userIds.length,
        subscriptionBlockedCount: null,
        addedCount: 0,
        failedCount: 0
      });
    } else if (linkSubscriptionBlocks === true) {
      queueSubscriptionSync(userIds, authorization, true);
    }
  }

  /**
   * Serialise block-list syncs, mirroring `queueSubscriptionSync`.
   *
   * On failure it publishes `status: "error"` rather than staying silent, so the
   * content script can stop holding the page hidden and reveal cached results.
   * The error message is BGG's status text; it contains no credential material.
   */
  function syncBlockList(force = false) {
    if (!authHeader) {
      return Promise.resolve();
    }

    if (syncPromise) {
      resyncRequested ||= force;
      return syncPromise;
    }

    const authorization = authHeader;
    syncPromise = performSync(authorization)
      .catch((error) => {
        publish({
          status: "error",
          message: error instanceof Error ? error.message : String(error),
          syncedAt: new Date().toISOString()
        });
      })
      .finally(() => {
        syncPromise = null;
        if (resyncRequested) {
          resyncRequested = false;
          syncBlockList();
        }
      });

    return syncPromise;
  }

  /**
   * Wrap `fetch` and `XMLHttpRequest` on the BGG page.
   *
   * Called only after consent. Both wrappers are strictly pass-through: they
   * observe, then delegate to the original function and return its result
   * unchanged. Neither blocks, rewrites, retries, nor inspects response bodies
   * of BGG's own requests.
   *
   * Two things are observed:
   *   1. `Authorization` headers, via `captureAuthorization`.
   *   2. Successful non-GET requests to `/api/userblock`, which mean the user
   *      just changed their block list in BGG's own UI — the cue to re-sync so
   *      the page updates without a reload.
   */
  function installInterceptors() {
    if (interceptorsInstalled) {
      return;
    }
    interceptorsInstalled = true;

    XMLHttpRequest.prototype.open = function patchedOpen(method, url, ...rest) {
      xhrMetadata.set(this, {
        method: String(method || "GET").toUpperCase(),
        url: String(url || "")
      });

      this.addEventListener(
        "loadend",
        () => {
          const metadata = xhrMetadata.get(this);
          if (
            consentGranted &&
            metadata?.url.includes("/api/userblock") &&
            metadata.method !== "GET" &&
            this.status >= 200 &&
            this.status < 300
          ) {
            syncBlockList(true);
          }
        },
        { once: true }
      );

      return originalXhrOpen.call(this, method, url, ...rest);
    };

    XMLHttpRequest.prototype.setRequestHeader = function patchedSetRequestHeader(name, value) {
      captureAuthorization(name, value);
      return originalXhrSetRequestHeader.call(this, name, value);
    };

    window.fetch = function patchedFetch(input, init) {
      // Headers can live on a Request object, on init, or both.
      if (input instanceof Request) {
        inspectHeaders(input.headers);
      }
      inspectHeaders(init?.headers);

      const method = String(init?.method || (input instanceof Request ? input.method : "GET")).toUpperCase();
      const url = String(input instanceof Request ? input.url : input);
      // Delegate first; the observation below never delays or alters the result.
      const request = originalFetch(input, init);

      if (consentGranted && url.includes("/api/userblock") && method !== "GET") {
        request.then((response) => {
          if (response.ok) {
            syncBlockList(true);
          }
        });
      }

      return request;
    };
  }

  document.addEventListener(SETTINGS_EVENT, acceptSettingsPayload);
  // The settings bridge may have published before this script ran, so read once
  // at startup rather than waiting for an event that already fired.
  acceptSettingsPayload();
})();
