# Primer pre-beta test report

Date: 2026-09-03. Tested against `server.mjs`/`store.mjs`/`primer.html` at commit `569868e`.
Method: an API probe (183 checks) and a headless-Chrome walkthrough (~300 UI checks) driving the
real server with a stubbed model, plus one full run on the real Claude subscription key.

The core product is in good shape. One live-model primer on "Why ice floats on water" came back
clean: four sections, three correct SVG diagrams, rendered math, no errors, about $0.53. Sharing,
the Inspector, export, the pen actions, define, rewrite, research, feedback, guest mode, history,
and mobile layout all work. Model output is sanitized thoroughly. The findings below are what a
beta tester could hit; none blocks launch on its own.

## Bugs, most important first

### 1. Two tabs lose a primer (lost-update on the library index)
Every save rewrites the whole `primer:index` array with the tab's in-memory copy. Two tabs on one
account each booted with their own copy, so the second tab to save overwrites the first tab's new
entry. The primer's document survives in storage but vanishes from the library.

Reproduced cleanly: two sessions, tab A creates a primer, tab B creates another; the final index
lists only tab B's, and tab A's primer is orphaned (present under `primer:doc:` but missing from the
index, so unreachable in the UI). Also happens if one tab writes a primer in the background while the
other starts one. Two tabs is a normal thing for a reader to do.

Fix direction: merge on the server (append/patch the index row) instead of storing the whole array
from the client, or re-read and merge the index before each write.

### 2. A reader's private edit instructions ship inside a shared link
`snapshot()` strips internal fields but keeps each block's `edit` stamp, including the `note` the
reader typed. On a frozen or public link the margin annotations show by default (`view.marks` is
true), and clicking a mark reveals the original instruction. So an Edit like "make this less
embarrassing" or an Ask that phrased something personal travels to anyone with the link, even when
the sharer never meant it to. Confirmed: a share payload carried an edit note verbatim.

Fix direction: drop `edit.note`/`edit.quote` from shared snapshots, or gate them behind the marks
switch being on, and say in the Share menu that annotations are included.

### 3. One person's failed logins can block everyone behind the same IP
The sign-in rate limiter (8 attempts per IP per minute) is shared by anonymous feedback, guest
key-linking, and login. Behind a NAT, a campus network, or a corporate proxy, many users share one
`x-forwarded-for`, so one person's mistyped passwords lock out everyone else's login and feedback for
a minute. Confirmed: after 8 bad logins from one IP, feedback and key-link from that IP returned 429,
and a correct login was refused too. Relevant given beta testers on `uw.edu`.

Also: the limiter trusts the client-sent `x-forwarded-for`. That is fine behind Fly's proxy (it
overwrites the header), but means the limit is bypassable anywhere the proxy does not.

Fix direction: limit login separately from feedback/link, key it on the account name as well as IP,
and only trust `x-forwarded-for` from a known proxy.

### 4. A primer finished, then reloaded within ~0.4s, is recorded as interrupted
Saves are debounced ~400ms and trace saves 0.6-2.5s. If the tab reloads or closes right after the
last block lands, the persisted status is still `writing`/`stopped` and the last calls read as "cut
off", so a finished primer reopens showing Resume and lost calls. The window is short but the failure
is confusing because nothing actually went wrong.

Fix direction: write immediately (not debounced) when a run reaches a terminal state in `finish()`.

### 5. HEAD requests return 405
`HEAD /` and `HEAD /s/<id>` answer 405 (only GET is allowed for files). Some link unfurlers and
uptime checks use HEAD; a share link pasted into such a tool would not preview. Low impact since most
unfurlers GET, but cheap to fix by treating HEAD like GET.

## Smaller notes
- `/api/store/primer:index` accepts literal `null` and arbitrary JSON. Harmless today but the page
  assumes shapes; a defensive check would avoid a future foot-gun.
- Guest shared-key passwords sit in `localStorage` in clear. This is by design and documented, noted
  only so it is a conscious choice for beta.
- Path traversal is safely blocked (encoded `..` gives 400, raw `..` in a path segment gives 404);
  static files outside the allowlist 404; `server.mjs`, the db, `.git`, and node_modules are not
  served.

## What was verified working
- Sign up / in / out, invite gate, name and password validation, admin = first account.
- Keys: add (key or token, kind auto-detected), refuse bad keys, rename, share with password,
  link by name+password, unlink, revoke by password change or unshare, per-day usage, active-key
  switching, ownership checks (no cross-account read/rename/delete/activate).
- Writing: outline stream, section stream with live prose, subsections and numbering, figures,
  images, research (citations, corrections, Wikipedia links), the planner note, definitions.
- Every failure path: section fails twice then halts with waiting sections and Resume; bad-JSON and
  500 retries; no-key and billing errors stop the run with the right message; Stop and Resume; finder
  finds nothing; reload mid-run; empty section.
- The pen: Explain, Example, Derive, Tighter, Diagram, Define, Edit, Ask, Complain, keyboard
  shortcuts, provenance popovers, sidenotes and hover-to-highlight, undo (button and Cmd+Z).
- Sharing: frozen and live links, revoking, stranger read-only view with the sharer's display
  settings, missing-link page. Snapshot correctly hides rewrite source, define context, and the call
  trace (but see #2).
- Inspector usage table and call tree; Markdown and PDF export; feedback and complaint to the admin
  inbox; guest mode with cred sent per call and migration on sign-in; deep links, back/forward
  history; mobile layout (docked pen, no horizontal scroll) and dark/paper themes.
- Model output XSS: scripts, event handlers, javascript:/data: URLs, iframes, meta-refresh, SVG
  foreignObject/use/animate, and style/link tags are all stripped; nothing executed.
