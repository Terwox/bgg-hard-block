(function installBggBlockListBridge() {
  "use strict";

  const API_ROOT = "https://api.geekdo.com/api";
  const AUTH_PREFIX = "GeekAuth ";
  const DATA_ELEMENT_ID = "bgg-hard-blocker-data";
  const DATA_EVENT = "bgg-hard-blocker:blocklist";
  const PROFILE_CACHE_KEY = "bgg-hard-blocker-profile-cache-v1";
  const PROFILE_CACHE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
  const SETTINGS_ELEMENT_ID = "bgg-hard-blocker-settings";
  const SETTINGS_EVENT = "bgg-hard-blocker:settings";

  const originalFetch = window.fetch.bind(window);
  const originalXhrOpen = XMLHttpRequest.prototype.open;
  const originalXhrSetRequestHeader = XMLHttpRequest.prototype.setRequestHeader;
  const xhrMetadata = new WeakMap();

  let authHeader = "";
  let attemptedAuthHeader = "";
  let lastBlockListPayload = null;
  let linkSubscriptionBlocks = null;
  let subscriptionResyncRequested = false;
  let subscriptionSyncPromise = null;
  let syncPromise = null;
  let resyncRequested = false;

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

  function captureAuthorization(name, value) {
    if (
      String(name).toLowerCase() !== "authorization" ||
      typeof value !== "string" ||
      !value.startsWith(AUTH_PREFIX)
    ) {
      return;
    }

    authHeader = value;
    if (attemptedAuthHeader !== value) {
      attemptedAuthHeader = value;
      queueMicrotask(syncBlockList);
    }
  }

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

  function normalizeApiLink(uri) {
    const url = new URL(String(uri || ""), `${API_ROOT}/`);
    if (url.origin !== new URL(API_ROOT).origin) {
      throw new Error("BGG returned a subscription pagination link on another origin");
    }
    return url.href;
  }

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

  function addSubscriptionBlock(userId, authorization) {
    return fetchApi(
      `${API_ROOT}/user/${encodeURIComponent(userId)}/blocks`,
      authorization,
      { method: "PUT", body: "" }
    );
  }

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

  function acceptSettingsPayload() {
    const settings = readSettingsPayload();
    if (typeof settings?.linkSubscriptionBlocks !== "boolean") {
      return;
    }

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

  async function performSync(authorization) {
    const rawBlockList = await fetchJson(`${API_ROOT}/userblock`, authorization);
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

  document.addEventListener(SETTINGS_EVENT, acceptSettingsPayload);
  acceptSettingsPayload();

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
    if (input instanceof Request) {
      inspectHeaders(input.headers);
    }
    inspectHeaders(init?.headers);

    const method = String(init?.method || (input instanceof Request ? input.method : "GET")).toUpperCase();
    const url = String(input instanceof Request ? input.url : input);
    const request = originalFetch(input, init);

    if (url.includes("/api/userblock") && method !== "GET") {
      request.then((response) => {
        if (response.ok) {
          syncBlockList(true);
        }
      });
    }

    return request;
  };
})();
