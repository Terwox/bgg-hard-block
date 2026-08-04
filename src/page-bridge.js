(function installBggBlockListBridge() {
  "use strict";

  const API_ROOT = "https://api.geekdo.com/api";
  const AUTH_PREFIX = "GeekAuth ";
  const DATA_ELEMENT_ID = "bgg-hard-blocker-data";
  const DATA_EVENT = "bgg-hard-blocker:blocklist";
  const PROFILE_CACHE_KEY = "bgg-hard-blocker-profile-cache-v1";
  const PROFILE_CACHE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

  const originalFetch = window.fetch.bind(window);
  const originalXhrOpen = XMLHttpRequest.prototype.open;
  const originalXhrSetRequestHeader = XMLHttpRequest.prototype.setRequestHeader;
  const xhrMetadata = new WeakMap();

  let authHeader = "";
  let attemptedAuthHeader = "";
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

  async function fetchJson(url, authorization) {
    const response = await originalFetch(url, {
      method: "GET",
      headers: {
        Accept: "application/json",
        Authorization: authorization
      },
      cache: "no-store",
      credentials: "omit"
    });

    if (!response.ok) {
      throw new Error(`BGG API returned ${response.status} for ${url}`);
    }

    return response.json();
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

  async function performSync(authorization) {
    const rawBlockList = await fetchJson(`${API_ROOT}/userblock`, authorization);
    const userIds = Array.isArray(rawBlockList)
      ? rawBlockList.map(String)
      : Array.isArray(rawBlockList?.userIds)
        ? rawBlockList.userIds.map(String)
        : [];
    const profiles = await resolveBlockedProfiles(userIds, authorization);

    publish({
      status: "ready",
      userIds,
      usernames: profiles.usernames,
      unresolved: profiles.unresolved,
      syncedAt: new Date().toISOString()
    });
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
