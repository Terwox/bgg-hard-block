(function exposeBggHardBlockerCore(root, factory) {
  const api = factory();

  if (typeof module === "object" && module.exports) {
    module.exports = api;
  }

  root.BggHardBlockerCore = api;
})(typeof globalThis === "object" ? globalThis : this, function createCore() {
  "use strict";

  const POST_SELECTOR = "gg-post, article.post";
  const QUOTE_SELECTOR = "gg-markup-quote";

  function normalizeUsername(value) {
    if (typeof value !== "string") {
      return "";
    }

    let decoded = value;
    try {
      decoded = decodeURIComponent(value);
    } catch (_error) {
      // A malformed percent escape should not stop the rest of the page filter.
    }

    return decoded
      .trim()
      .replace(/^@+/, "")
      .replace(/\s+/g, " ")
      .toLocaleLowerCase("en-US");
  }

  function usernameFromProfileHref(href) {
    if (typeof href !== "string") {
      return "";
    }

    const match = href.match(/\/profile\/([^?#/]+)/i);
    return match ? normalizeUsername(match[1]) : "";
  }

  function canonicalPost(element) {
    if (!element || element.nodeType !== 1) {
      return null;
    }

    if (element.matches("gg-post")) {
      return element;
    }

    return element.closest("gg-post") || element;
  }

  function postArticle(post) {
    if (!post || post.nodeType !== 1) {
      return null;
    }

    return post.matches("article.post")
      ? post
      : post.querySelector(":scope > article.post");
  }

  function postUsername(post) {
    const article = postArticle(post);
    const header = article?.querySelector(":scope > .post-header");
    const profileLink = header?.querySelector('a[href*="/profile/"]');
    const fromHref = usernameFromProfileHref(profileLink?.getAttribute("href"));

    if (fromHref) {
      return fromHref;
    }

    const microdataUrl = header?.querySelector(
      'meta[itemprop="url"][content*="/profile/"]'
    );
    return usernameFromProfileHref(microdataUrl?.getAttribute("content"));
  }

  function quoteUsername(quote) {
    if (!quote || quote.nodeType !== 1) {
      return "";
    }

    const explicit = quote.getAttribute("data-username");
    if (explicit) {
      return normalizeUsername(explicit);
    }

    const attribution =
      quote.querySelector(".c-header .user-attribution") ||
      quote.querySelector(".c-header gg-user-attribution") ||
      quote.querySelector(".c-header");

    if (!attribution) {
      return "";
    }

    const rawAttribution = attribution.textContent || attribution.innerText || "";
    const trailingHandle = rawAttribution.match(/@([^@\r\n]+?)\s*$/);
    if (trailingHandle) {
      return normalizeUsername(trailingHandle[1]);
    }

    const lines = rawAttribution
      .split(/[\r\n]+/)
      .map((line) => line.trim())
      .filter(Boolean);
    const handleLine = [...lines].reverse().find((line) => line.startsWith("@"));

    if (handleLine) {
      return normalizeUsername(handleLine);
    }

    const wroteMatch = lines.join(" ").match(/^(.+?)\s+wrote:\s*$/i);
    return wroteMatch ? normalizeUsername(wroteMatch[1]) : "";
  }

  function isNativeBlockedPlaceholder(post) {
    const article = postArticle(post);
    const body = article?.querySelector(":scope > .post-body");

    if (!body) {
      return false;
    }

    const bodyText = (body.textContent || body.innerText || "")
      .replace(/\s+/g, " ")
      .trim();
    const buttonText = Array.from(body.querySelectorAll("button"))
      .map((button) => (button.textContent || button.innerText || "").trim())
      .join(" ");

    return (
      /\bBlocked User/i.test(bodyText) &&
      /\bShow Anyway\b/i.test(buttonText)
    );
  }

  function collectElements(root, selector) {
    const elements = [];

    if (root?.nodeType === 1 && root.matches(selector)) {
      elements.push(root);
    }

    if (typeof root?.querySelectorAll === "function") {
      elements.push(...root.querySelectorAll(selector));
    }

    return elements;
  }

  function collectPosts(root) {
    const seen = new Set();

    return collectElements(root, POST_SELECTOR)
      .map(canonicalPost)
      .filter((post) => {
        if (!post || seen.has(post)) {
          return false;
        }
        seen.add(post);
        return true;
      });
  }

  function makeBlockedSet(usernames) {
    return new Set(
      Array.from(usernames || [])
        .map(normalizeUsername)
        .filter(Boolean)
    );
  }

  function filterDom(root, blockedUsernames) {
    const blocked =
      blockedUsernames instanceof Set
        ? makeBlockedSet(blockedUsernames)
        : makeBlockedSet(blockedUsernames);
    const result = { posts: 0, quotes: 0 };

    for (const post of collectPosts(root)) {
      if (!post.isConnected) {
        continue;
      }

      const author = postUsername(post);
      if (isNativeBlockedPlaceholder(post) || (author && blocked.has(author))) {
        post.remove();
        result.posts += 1;
      }
    }

    for (const quote of collectElements(root, QUOTE_SELECTOR)) {
      if (!quote.isConnected) {
        continue;
      }

      const author = quoteUsername(quote);
      if (author && blocked.has(author)) {
        quote.remove();
        result.quotes += 1;
      }
    }

    return result;
  }

  return Object.freeze({
    filterDom,
    isNativeBlockedPlaceholder,
    makeBlockedSet,
    normalizeUsername,
    postUsername,
    quoteUsername,
    usernameFromProfileHref
  });
});
