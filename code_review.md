# Code review: concerns and recommended fixes

Against the working tree at 419d6de plus uncommitted changes, 2026-09-03.
Verify each before acting; if one turns out not to hold, skip it and say
so. The standard throughout is the simplest fix, and every fix below
should remove code or leave the count about even. Two decisions are
settled: the JSON-blob storage stays as it is, with no new tables, and
block flags stay on the block object with `TRANSIENT` stripping them on
save.

## 1. Model output is inserted as unsanitized HTML

`blockEl` sets `fig.innerHTML` to the figure's SVG with only `<script>`
tags regexed out, and `body.innerHTML = mdToHtml(b.md)` for prose.
`marked` passes raw HTML through. Captions via `mdInline` and the
`defNodes` preview are the same. An `onload` on an SVG element, a
`<foreignObject>`, or an `<img onerror>` in prose all run. Shares are
same-origin with everyone's session cookie, and the share body is
client-supplied, so a shared primer can act as its reader against every
`/api/` route, including re-passwording their shared key. The research
agent writing `b.md = String(c.md)` from web content is a second way in.

**Fix.** DOMPurify from cdnjs, pinned like KaTeX and marked. One helper
next to `mdToHtml` with two profiles: prose, and SVG with `foreignObject`
and event attributes forbidden. Route all five `innerHTML` assignments of
model-derived content through it. KaTeX runs on the DOM afterwards, so
sanitizing the string first is fine. Add `primer` to the allowed URL
schemes so `wireLinks` still finds its hrefs. Not a CSP header instead;
that can come later as an extra.

## 2. `liveSnapshot` duplicates `snapshotOf`

The server rebuilds the page's snapshot logic for live links and reads
inside `primer:doc:<id>` and `primer:settings` to do it. The two copies
have drifted: the server drops `checked`, the client does not; `unfilled`
and the `primer:` link regex are pasted into both files; display switches
are read via `setting()` on one side and `!== false` on the other; the
client attaches a usage line, the server does not. Both file headers
still describe the server as not knowing what is in the blobs, and the
`server.mjs` header still says a share never changes.

**Fix.** For a live share, the GET returns the two stored blobs as-is:
`{id, by, created, live:true, doc, settings}`. Keep `mediaOf` for the
`share_media` insert, since it only looks at `src` strings. For the
`/s/<id>` page title, read `.title` from the parsed doc with the stored
title as fallback, and comment that this one field is all the server
reads. On the client, give `snapshotOf` a `view` parameter and add a
one-line `viewOf(settings)` used by both the freeze path and the reader's
live path. `openShared` and `watchShared` then build the live doc with
`snapshotOf(s.doc, viewOf(s.settings))`. Delete `liveSnapshot` and the
server's `unfilled` and `drop` list. Fix both headers.

Persisted docs are already `cleanBlock`ed, so unwritten sections arrive
as `{slot:true, md:""}` and `unfilled` drops them; a live link opened
mid-write should look as it does today.

## 3. `retry` and `remove` closures on blocks

Assigned in about thirteen places (`resumable`, `build`, `genSection`,
`markStopped`, `markWaiting`, `failedVisual`, `imageNode`'s `onerror`),
stripped by `TRANSIENT`, reconstructed by `resumable` after reload. The
action is fully determined by the block, so storing it is redundant and
the redundancy is what `resumable` mostly exists to repair.

**Fix.** `errNode` derives the action: `b.slot` gets Retry as
`retrySection(doc, b.sec)` (which already covers `markWaiting`'s
`resume`); a figure or image with a `brief` gets Retry as
`retryVisual(doc, b, true)` and Remove as `swapBlock` plus `save`;
otherwise Retry is `build(doc)`. Delete every assignment, drop both names
from `TRANSIENT`, and cut `resumable` to setting `error` and `stopped`
text from the trace and turning an in-progress status into stopped.

## 4. Trace blob size

`saveTrace` PUTs the whole `primer:raw:<id>` every 2.5 s while streaming;
150 records at 60 KB per field, plus event lists, can pass the 8 MB store
limit on a research-heavy primer, after which recording silently stops.
Not worth structure. Lower `TRACE_TEXT` to around 20,000, maybe
`TRACE_MAX` too. Nothing else.

## 5. Server file order and two name collisions

`mediaOf`, `liveSnapshot` and `PAGE_PATH` sit between the comment for
`explain` and `explain` itself; `mediaOf` uses `MEDIA_NAME`, declared
180 lines later. After concern 2 removes `liveSnapshot`, move `mediaOf`
beside the share routes and `PAGE_PATH` beside the static handler.
Rename the server's `usageOf` and `explain`, which collide with unrelated
client functions of the same names.

## 6. Optional, when next touching the area

- **Agent in five places.** `ROLES` on the server, `PROMPTS` and
  `AGENTS` on the client, the prompt files, and the role list inside
  `liveText`. When an agent is next added: give `ROLES` entries a display
  name and a `prose` flag, serve the table at boot next to the prompts,
  delete `AGENTS` and the hard-coded list in `liveText`.
- **URL parsing in three client places.** `sharePath` plus the `/guide`
  test in `boot`, and `openLanding`. One `parsePath` used by both.
  `PAGE_PATH` on the server stays.
- **Three inline delete confirmations** (`confirmRow`, the colophon,
  `keysControl`) and **two clipboard fallbacks** (`copyLink`, `copyText`).
  One confirm helper; `copyLink` calls `copyText` and keeps only its menu
  fallback.

## Withdrawn

Considered and rejected as complexity without enough gain. Do not do
these: transient flags in a side map; a primers table; computing the
index from the docs; a calls table; a dirty-flag redraw scheduler; a
route table for `serve`; splitting `SETTINGS` from page layout; unifying
the three positioning clamps; making the live-share GET read-only.

## Order

1 on its own commit. Then 2 with 5, since they move the same code. Then
3. Fold 4 in anywhere. 6 waits.
