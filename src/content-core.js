// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Terwox
//
// This file is part of BGG Hard Block. See the LICENSE file at the repository
// root for the full license text.

/**
 * Pure filtering logic: given a DOM subtree and a set of blocked usernames,
 * decide what to remove.
 *
 * ## Why this is a separate file
 *
 * Everything here is deterministic and side-effect-free apart from the DOM
 * removals it is asked to perform. No `chrome.*` APIs, no network, no storage.
 * That makes it directly unit-testable in Node (see `tests/`) and keeps the
 * privacy-relevant code confined to `page-bridge.js` and `content.js`.
 *
 * It uses a UMD-style wrapper so the same file can be loaded as a content script
 * (attaching to `globalThis.BggHardBlockerCore`) and `require`d by the tests.
 *
 * ## What "blocked" means here
 *
 * Two independent reasons a post is removed:
 *
 *   1. **BGG already knows it's blocked.** BGG renders a "Blocked User /
 *      Show Anyway" placeholder. This is the resilient case — it depends only on
 *      BGG's placeholder markup, not on the block list syncing correctly.
 *   2. **The author is on the synced block list.** This catches posts BGG chose
 *      to render normally, and quotations, which BGG does not filter at all.
 *
 * @see BUILD.md for how to verify this file is what's running.
 */
(function exposeBggHardBlockerCore(root, factory) {
  const api = factory();

  if (typeof module === "object" && module.exports) {
    module.exports = api;
  }

  root.BggHardBlockerCore = api;
})(typeof globalThis === "object" ? globalThis : this, function createCore() {
  "use strict";

  // BGG's Angular frontend wraps each post in a <gg-post> custom element
  // containing an <article class="post">. Both are matched because lazy-loaded
  // and server-rendered posts do not always arrive with the same outer wrapper.
  const POST_SELECTOR = "gg-post, article.post";
  const QUOTE_SELECTOR = "gg-markup-quote";

  // Matches one BBCode quote token: [q], [q=name], [q="name"], [q='name'], [/q].
  // Groups 2/3/4 are the double-quoted, single-quoted, and bare username forms.
  // Global flag means `lastIndex` must be reset before each use — see
  // sanitizeBlockedQuotes.
  const BBCODE_QUOTE_TOKEN = /\[(\/?)q(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\]\r\n]+?)))?\s*\]/gi;

  /**
   * Reduce a username to a stable comparison key.
   *
   * BGG surfaces usernames in several shapes — URL-encoded in profile hrefs,
   * `@`-prefixed in quote attributions, with stray whitespace in text nodes.
   * All comparisons in this file happen on normalised values so those variants
   * collapse to one key.
   *
   * Lowercasing is pinned to `en-US` rather than the user's locale, because
   * locale-sensitive casing differs (notably Turkish dotless i) and would make
   * matching depend on browser settings.
   */
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

  /** Pull a username out of a `/profile/<name>` URL. */
  function usernameFromProfileHref(href) {
    if (typeof href !== "string") {
      return "";
    }

    const match = href.match(/\/profile\/([^?#/]+)/i);
    return match ? normalizeUsername(match[1]) : "";
  }

  /**
   * Resolve any post-ish element up to the outermost element worth removing.
   *
   * Removing the inner `article.post` alone would leave an empty `<gg-post>`
   * shell behind, which BGG's layout still reserves space for.
   */
  function canonicalPost(element) {
    if (!element || element.nodeType !== 1) {
      return null;
    }

    if (element.matches("gg-post")) {
      return element;
    }

    return element.closest("gg-post") || element;
  }

  /** Get the `article.post` inside a post wrapper, or the element if it is one. */
  function postArticle(post) {
    if (!post || post.nodeType !== 1) {
      return null;
    }

    return post.matches("article.post")
      ? post
      : post.querySelector(":scope > article.post");
  }

  /**
   * Determine a post's author.
   *
   * Two sources, in order of reliability:
   *   1. the profile link in the post header
   *   2. the microdata `<meta itemprop="url">`, which survives on some
   *      lazy-rendered posts where the visible link has not been hydrated yet
   *
   * `:scope >` is used throughout so a *quoted* post nested inside this one
   * cannot be mistaken for its author.
   *
   * @returns {string} Normalised username, or `""` if it cannot be determined.
   */
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

  /**
   * Determine who a quotation is attributed to.
   *
   * Harder than `postUsername` because BGG renders quote attribution as free
   * text with no stable machine-readable author. Four strategies, cheapest and
   * most reliable first:
   *
   *   1. an explicit `data-username` attribute, when present
   *   2. a trailing `@handle` anywhere in the attribution text
   *   3. the last line that starts with `@`
   *   4. the legacy `Name wrote:` form
   *
   * Returning `""` is the safe failure: an unattributable quote is left alone
   * rather than guessed at, because removing a quote from an allowed post
   * damages a conversation the user wanted to read.
   */
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
    // Reversed: when a quote nests, the outermost attribution comes last.
    const handleLine = [...lines].reverse().find((line) => line.startsWith("@"));

    if (handleLine) {
      return normalizeUsername(handleLine);
    }

    const wroteMatch = lines.join(" ").match(/^(.+?)\s+wrote:\s*$/i);
    return wroteMatch ? normalizeUsername(wroteMatch[1]) : "";
  }

  /**
   * Detect BGG's own "Blocked User / Show Anyway" placeholder.
   *
   * This is the single most durable check in the extension: it needs no synced
   * block list, so it keeps working even if the API contract changes entirely.
   *
   * Two detection paths:
   *   1. the semantic `ngbtooltip` marker, which is language-independent
   *   2. a text fallback requiring *both* a "Blocked User" body and a reveal
   *      control — both conditions, so an ordinary post that merely discusses
   *      blocking is not removed
   *
   * The text fallback is English-only. If BGG localises these strings, path 1
   * still holds.
   */
  function isNativeBlockedPlaceholder(post) {
    const article = postArticle(post);
    const body = article?.querySelector(":scope > .post-body");

    if (!body) {
      return false;
    }

    const semanticBlockedMarker = body.querySelector(
      ':scope > [ngbtooltip*="blocked content" i]'
    );
    if (semanticBlockedMarker) {
      return true;
    }

    const bodyText = (body.textContent || body.innerText || "")
      .replace(/\s+/g, " ")
      .trim();
    const revealText = Array.from(body.querySelectorAll(":scope > button, :scope > a"))
      .map((button) => (button.textContent || button.innerText || "").trim())
      .join(" ");

    return (
      /\bBlocked User/i.test(bodyText) &&
      /\b(?:Show Anyway|Show (?:hidden|blocked) (?:post|content))\b/i.test(revealText)
    );
  }

  /**
   * Collect matching elements including the root itself.
   *
   * `querySelectorAll` never returns its own root, but mutation records
   * frequently hand us the matched element directly, so both must be considered.
   */
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

  /**
   * Collect posts, deduplicated after canonicalisation.
   *
   * `POST_SELECTOR` matches both the wrapper and the inner article, so a single
   * post is found twice and canonicalises to the same node; the `seen` set keeps
   * it from being processed and counted twice.
   */
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

  /** Build a normalised, empty-free Set from any iterable of usernames. */
  function makeBlockedSet(usernames) {
    return new Set(
      Array.from(usernames || [])
        .map(normalizeUsername)
        .filter(Boolean)
    );
  }

  /**
   * Strip blocked users' quotations out of a reply draft.
   *
   * When BGG's **Quote** button is clicked, it inserts the quoted post as nested
   * BBCode into the reply textarea — including any quotations *that* post
   * contained. So replying to an allowed post can drag a blocked user's words
   * back into the user's own draft.
   *
   * This walks the tokens maintaining a stack of open `[q]` tags. When a `[/q]`
   * closes a tag whose author was blocked, the whole span from opening to
   * closing tag is marked for removal — which naturally takes any nested quotes
   * inside it too. Text outside those spans, including the allowed post being
   * replied to, is preserved exactly.
   *
   * Overlapping ranges are merged before splicing so nested blocked quotes do
   * not double-cut the string.
   *
   * Unbalanced markup fails safe: an unclosed `[q=blocked]` never produces a
   * range, so nothing is removed rather than truncating the user's draft.
   *
   * @param {string} value Raw textarea contents.
   * @param {Iterable<string>} blockedUsernames
   * @returns {string} The draft with blocked quote subtrees removed.
   */
  function sanitizeBlockedQuotes(value, blockedUsernames) {
    if (typeof value !== "string" || !value) {
      return typeof value === "string" ? value : "";
    }

    const blocked = makeBlockedSet(blockedUsernames);
    if (!blocked.size) {
      return value;
    }

    const stack = [];
    const ranges = [];
    // The regex is global and shared; reset before iterating or a previous call
    // would cause this one to start mid-string.
    BBCODE_QUOTE_TOKEN.lastIndex = 0;

    for (let match = BBCODE_QUOTE_TOKEN.exec(value); match; match = BBCODE_QUOTE_TOKEN.exec(value)) {
      if (match[1]) {
        // Closing [/q]: if the tag it closes was a blocked author's, record the
        // full span for removal.
        const opening = stack.pop();
        if (opening?.blocked) {
          ranges.push([opening.start, BBCODE_QUOTE_TOKEN.lastIndex]);
        }
        continue;
      }

      const username = normalizeUsername(match[2] ?? match[3] ?? match[4] ?? "");
      stack.push({
        blocked: Boolean(username && blocked.has(username)),
        start: match.index
      });
    }

    if (!ranges.length) {
      return value;
    }

    // Merge overlaps: a blocked quote nested inside another blocked quote yields
    // two ranges covering the same text.
    ranges.sort((left, right) => left[0] - right[0]);
    const merged = [];
    for (const range of ranges) {
      const previous = merged.at(-1);
      if (previous && range[0] <= previous[1]) {
        previous[1] = Math.max(previous[1], range[1]);
      } else {
        merged.push([...range]);
      }
    }

    let cursor = 0;
    let sanitized = "";
    for (const [start, end] of merged) {
      sanitized += value.slice(cursor, start);
      cursor = end;
    }
    return sanitized + value.slice(cursor);
  }

  /**
   * Remove blocked posts and quotations from a DOM subtree.
   *
   * The entry point used by both the initial pass and every `MutationObserver`
   * callback. Safe to call repeatedly on overlapping subtrees: already-removed
   * nodes fail the `isConnected` check and are skipped, so counts stay accurate.
   *
   * @param {Node} root Document or subtree to filter.
   * @param {Iterable<string>|Set<string>} blockedUsernames
   * @returns {{posts: number, quotes: number}} How many nodes were removed.
   */
  function filterDom(root, blockedUsernames) {
    const blocked = makeBlockedSet(blockedUsernames);
    const result = { posts: 0, quotes: 0 };

    for (const post of collectPosts(root)) {
      // A previous iteration may have removed an ancestor of this node.
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
      // Unattributable quotes (author === "") are deliberately left in place.
      if (author && blocked.has(author)) {
        quote.remove();
        result.quotes += 1;
      }
    }

    return result;
  }

  // Frozen so a compromised or buggy caller cannot swap out a filter function
  // that the rest of the extension trusts.
  return Object.freeze({
    filterDom,
    isNativeBlockedPlaceholder,
    makeBlockedSet,
    normalizeUsername,
    postUsername,
    quoteUsername,
    sanitizeBlockedQuotes,
    usernameFromProfileHref
  });
});
