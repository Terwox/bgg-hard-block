---
name: Firefox bug
about: Something misbehaves in Firefox
title: ''
labels: bug, firefox
assignees: ''
---

## What happened

<!-- e.g. "the popup says sync-failed" or "nothing is hidden, but the same
     profile works in Chrome" -->

## Where

BGG URL (a public thread is ideal):

## Firefox version

Open `about:support` and copy the **Version** row under Application Basics.
The extension needs Firefox 153 or newer.

- Firefox version:
- Extension version:
- OS:
- Installed from AMO, or loaded temporarily from `about:debugging`?

## Is site access granted?

Firefox lets you revoke the extension's host access, and the extension does
nothing without it. Open `about:addons` → **BGG Hard Block** → **Permissions**
and say whether access to `boardgamegeek.com` and `api.geekdo.com` is on.

- Site access:

## Popup status text

Click the toolbar icon and paste the status line it shows, verbatim.

```

```

## Browser Console output

Open the Browser Console with **Ctrl+Shift+J** (**Cmd+Shift+J** on macOS), type
`bgg-hard-block` into its filter box, reload the BGG page, and paste what
appears.

<details>
<summary>Browser Console</summary>

```

```

</details>

## Does it also happen in Chrome?

If you can check, this is the single most useful line in the report: it
separates a Firefox port bug from a BGG markup change.

- [ ] Chrome behaves the same way
- [ ] Chrome works correctly
- [ ] Haven't checked

## Please check before submitting

- [ ] I have removed my username and any other personal details from the output above
- [ ] I have **not** included my BGG session cookie, `GeekAuth` header, or password
