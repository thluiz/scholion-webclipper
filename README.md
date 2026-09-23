# scholion-webclipper

An API that turns a URL into a Scholion `category: webclip` note: render the
page, extract clean content, compose a resumo + fichamento (via
vox-intelligence), audit it for voice/source violations, and — once it
passes, or a human overrides it — write and commit both the raw clipping and
the composed note into the Scholion repository.

This document is a design record, not just a usage guide: every non-obvious
choice below exists because of a concrete problem observed in the sibling
tools it replaces or reuses (`fetch-webclip.mjs`, the interactive
`add-scholion-webclip` Claude Code skill, and `scholion-places`, the closest
existing precedent). Read it before changing the architecture, not just
before calling the API.

**Status: design draft, not yet implemented.** This README exists so the
design can be reviewed before code is written.

## Problem statement

Today, capturing a webclip runs entirely inside an interactive Claude Code
session:

1. `fetch-webclip.mjs` (Playwright) renders the page and grabs
   `(article||main||body).innerText` — a naive heuristic, no real boilerplate
   removal, plain text instead of Markdown.
2. The Claude Code agent reads that raw text into its own paid conversation
   context and composes the resumo/fichamento by hand, applying the
   `ghost-writer` voice rules from a loaded skill file.
3. The agent calls `vox-intelligence`'s `/presets/scholion/ghost-audit`
   endpoint, shows the JSON findings to the author, and waits for approval.
4. The agent writes the files and commits, gated by a pre-commit hook that
   checks for a `.ghost-audit/<blob>.ok` marker.

Two separate pressures make this insufficient going forward:

- **Cost.** Step 2 burns a large amount of the interactive session's paid
  tokens reading a full page and drafting prose in-context — the same
  problem that motivated moving podcast annotation server-side (see
  `vox-intelligence`'s `suggest-annotations`/`annotate` presets). A first
  pass at this (`webclip-summary` preset in `vox-intelligence`, already
  shipped) moved composition server-side, but the *fetch* step and the
  *orchestration* (search-first, preview, gate, commit) still run inside the
  interactive agent, which is where most of the token cost was.
- **Autonomy.** The eventual goal is for this to run as an action a more
  autonomous agent (OpenClaw, "Claudinho") can call directly — without a
  human watching a chat turn by turn. Everything in steps 3–4 above depends
  on a *human being present in the conversation* to read findings and decide.
  That doesn't exist when the caller is an unattended agent. The
  authorization and quality gate has to move from "a chat turn a human
  reads" to "an explicit, inspectable server-side check with its own
  authorization boundary."

Both problems point the same direction: extraction, composition and the
quality gate all need to live behind an HTTP API, not inside the calling
agent's context.

## Decision 1 — implementation language: Node/Bun, not Python/C#/Elixir

Three ecosystems were evaluated for the render+extract half of this problem
(rendering a JS-heavy page, dismissing cookie-consent walls, extracting main
content, converting to clean Markdown):

| | Headless rendering | Extraction + Markdown | Verdict |
|---|---|---|---|
| **Python** | `playwright` (official Microsoft bindings, same engine) | `trafilatura` — one call, native Markdown output | Strong. Roughly tied with Node on accuracy depending which benchmark you read. |
| **C#** | `Microsoft.Playwright` (official) | `SmartReader` (maintained Readability port) + `ReverseMarkdown` (two packages) | Strong, marginally more moving parts than Python/Node. |
| **Elixir** | No official/mature Playwright binding — the `playwright` hex package is explicitly labeled alpha/preview by its own author, "not recommended for production." `Wallaby` (ChromeDriver-based) is more production-tested but historically more fragile with heavy SPAs. | `readability` hex package is unmaintained since Jan 2024. No maintained Trafilatura/SmartReader equivalent exists. | Weakest option, despite Toscanini already running Elixir in this environment. Would mean hand-rolling extraction on top of `Floki`. |
| **Node** | `playwright` (official, same engine as the other two — and what the current script already uses) | `@mozilla/readability` — the **reference implementation** Python's and C#'s ports are both derived from — + `jsdom` (to parse the HTML Playwright already rendered; jsdom's own inability to execute JS doesn't matter here because Playwright did that step already) + `turndown` for Markdown | Chosen. |

Two benchmarks were checked for Readability vs Trafilatura accuracy and they
disagree on which wins (one gives Trafilatura ~0.937 F1 vs Readability's
~0.914; another gives Readability ~0.94 vs Trafilatura's ~0.91, using a
different dataset). Treat the two as roughly comparable, not as a decisive
gap in either direction — the accuracy question did not decide this.

**What did decide it:** zero migration cost. The current script is already
Node + Playwright; `@mozilla/readability` is the library the Python and C#
ports both copy; `vox-intelligence` (the service this one talks to for
composition) already runs on Bun; and staying in one runtime avoids standing
up a second language's deployment story (interpreter/runtime install,
dependency manager, systemd unit template) on HermesTools for marginal
accuracy differences that don't clearly favor another language anyway.

**Tradeoff accepted:** Playwright needs a full browser binary on the host,
which is a meaningfully heavier dependency than `vox-intelligence`'s
declared "Bun built-ins only, no external dependencies" philosophy. That's
why this is its own service and not a route added to `vox-intelligence` —
see Decision 5.

## Decision 2 — two-phase `compose` → `save`, not a single call

A single `POST /webclip {url}` that fetches, composes, and writes to disk in
one shot would be simpler to call. It was rejected because it collapses two
things that need different authorization:

- **Compose** is pure computation: fetch, extract, ask an LLM to draft
  prose, run the ghost-audit checklist against that draft. No side effects,
  safe for any caller to invoke.
- **Save** is the one step with consequences: it writes into the Scholion
  repository and creates a commit. This is exactly the step the interactive
  skill currently gates behind a human reading ghost-audit findings and
  explicitly approving. An unattended agent calling this API has no
  equivalent of "a human reads the chat and decides" — so the gate has to be
  an explicit, checkable precondition on `save`, not a courtesy the caller
  is trusted to honor.

Splitting them means `save` can *enforce* "verdict is green or yellow, or
the caller holds the override capability" as a real authorization check,
instead of a convention an agent prompt merely asks the caller to follow —
the same lesson `scholion-places`' ACL design states explicitly: "an
instruction in a prompt is a suggestion, an absent capability is a
boundary."

**Mechanism:** `compose` returns an `operationId` (a server-generated token)
alongside the drafted clipping, note, and audit verdict. Nothing is written
yet. `save` takes that `operationId`, re-validates it server-side (exists,
not expired, not already consumed, verdict acceptable for the caller's
authorization level — see Decision 3), and only then writes and commits.

The operation record is stored server-side (not trusted from the client) so
a caller can't hand back a doctored verdict. It expires (draft: 24h) because
a stale draft against a page that has since changed, or a note someone
already created by hand in the meantime, shouldn't be silently publishable
long after it was composed. It's consumed exactly once, closing the race
where two `save` calls against the same operation would otherwise double
the commit.

## Decision 3 — the override is a separate, higher-privileged operation

`save` refuses a `red` verdict by default. Overriding that has to exist
(mirrors the conscious `.ghost-audit/<blob>.ok` marker the interactive
skill already uses — see `feedback_ghost_audit_gate_estrito` in the
Scholion project's memory: the gate stays strict by design, and bypassing it
is meant to be a deliberate, visible act, never silent).

The override is **not** a boolean the same caller who requested `compose`
can flip on their own request. It's gated behind a separate ACL operation
(`webclip.save.force`) that only a higher-privileged principal holds. A
caller authorized only for `webclip.compose` + `webclip.save` (the
autonomous-agent role) can save anything that already passed the audit, but
cannot self-authorize past a `red` verdict — only a principal explicitly
granted the force operation (the human's key) can. If the same credential
could both produce a red-verdict draft and force it through, the gate would
be decorative.

## Decision 4 — reuse `scholion-places`' ACL and rate-limit modules wholesale

`scholion-places` (`E:\scholion-places`), already running in production on
this host, solved authorization and abuse-prevention for exactly this class
of problem: an API a bot might call, backed by a git-versioned Markdown
repository, that a human also needs privileged access to.

- **`acl.ts`** — API-key-identified principals, roles (`read`/`write`/
  `admin`), per-principal `allow`/`deny` overrides on top of a role, and the
  rule that a denied operation is omitted from `GET /me` rather than merely
  refused when called (so a calling agent never learns a capability exists
  to try it). This is reused close to verbatim; only the `OPERATIONS` list
  changes to name this service's own operations
  (`webclip.compose`, `webclip.save`, `webclip.save.force`, `webclip.get`,
  `webclip.discard`).
- **`budget.ts`** (`WriteBudget`) — a per-principal per-minute/per-day
  ceiling, sized to stop a retry loop, not a person. Directly relevant here
  because `compose` calls a paid LLM through `vox-intelligence`; an agent
  stuck retrying a failing compose call is not just a nuisance, it's a
  metered cost. Reused unchanged.
- **Deployment pattern** — `scholion-places`' README documents stamping
  `X-Api-Key` from the reverse proxy (one `location` block per principal) so
  the client holds no credential it could swap to escalate itself; the proof
  of identity is which path the request arrived on. The same pattern is the
  intended production deployment here, once this sits behind nginx on
  HermesTools alongside the other services.

Rewriting either module from scratch was considered and rejected: this
exact problem (bot-callable, git-backed, needs a human-only escape hatch)
was already solved once on this host, and the existing solution had no
webclip-specific coupling to unwind.

## Decision 5 — its own `vault/` clone, not the live `E:\scholion` working tree

`scholion-places` clones the content repository into its own `vault/`
directory rather than operating on anyone's local working copy, and its
README states the reason plainly: the service is one of at least two
writers (itself and a human with a text editor), and treating someone's live
checkout as the thing it commits into invites exactly the kind of collision
already seen in this pipeline — the batch playbook for webclip imports has
to explicitly warn against a bare `git commit` because `E:\scholion` has
"other concurrent activity, e.g. a scheduled publish task's pre-push hook
and possibly other live sessions."

`scholion-webclipper` adopts the same isolation: its own clone, its own
git-operation queue (validate → write → add → commit with an explicit
pathspec, never `add -A` → `pull --rebase` → push), commit synchronous in
the response, push backgrounded with retry so a slow network doesn't make
`save` feel slow. The interactive Claude Code skill keeps writing directly
into the live working tree when a human is driving it — that's unaffected
by this service existing.

**Resolved:** one commit per `save` call, covering both the clipping and
the note. The interactive skill's own convention (one commit per artifact —
clipping, then note, as two separate commits) exists because a human drives
that flow one file at a time and might reasonably stop between them. Here,
`save` is a single atomic unit of work with a single caller decision behind
it ("this operation is good, write it") — splitting that into two commits
would only create a window where the clipping exists without the note it
was captured for, with no benefit to match.

## Decision 6 — ghost-audit runs by calling the existing preset, not by reimplementing it

`compose` calls `vox-intelligence`'s already-shipped
`POST /presets/scholion/ghost-audit` endpoint against the drafted note,
exactly as the interactive skill does today. It does not reimplement the
checklist. The system prompt embedded in the `webclip-summary` preset
already reduces how often that audit comes back non-green (see that
preset's own design note), but it does not replace the audit — the two
serve different purposes: `webclip-summary`'s prompt is aimed at reducing
*rework*, the ghost-audit call is the actual *authorization signal* `save`
checks.

## Decision 7 — errors are a structured, machine-readable contract

Every error response is JSON with a stable `code`, a human `message`, and a
`retryable` boolean:

```json
{
  "error": {
    "code": "blocked_domain",
    "message": "...",
    "retryable": false,
    "details": { }
  }
}
```

This is a direct response to two real incidents from batch-processing
webclips by hand before this service existed:

- A subagent hit a domain known to block scraping and, with no structured
  signal telling it to stop, chained Playwright → WebFetch → manual `curl`
  trying to save one URL, burning 135 tool calls.
- `fetch-webclip.mjs`'s process-level timeout, with no clean timeout
  response, caused the calling shell tool to move the command to the
  background automatically — the subagent then waited on a notification
  that only ever reaches an orchestrator, not itself, and stalled.

`retryable: false` on codes like `blocked_domain` or `thin_content` lets a
caller fail fast in one attempt instead of inferring "this isn't working"
from a generic failure after several retries. `retryable: true` on
transport-level codes (`fetch_timeout`, network errors) is where retry-with-
backoff is actually appropriate. The service also enforces its own internal
render timeout, shorter than any reasonable HTTP client timeout, so a slow
page always comes back as a clean `fetch_timeout` response instead of the
connection hanging.

Codes are deliberately aligned with the skip-reason vocabulary the batch
playbook (`add-scholion-webclip/batch-playbook.md`) already logs
(`thin_unrecoverable`, `audit_unresolved`, `build_failed`) so the same
taxonomy is legible whether a human batch-processed the backlog by hand or
this API did it.

| Code | Meaning | `retryable` |
|---|---|---|
| `fetch_timeout` | Render exceeded the internal timeout | `true` |
| `fetch_failed` | Navigation/network error | `true` |
| `blocked_domain` | Known-hostile-to-scraping domain (X/Twitter, Reddit, Cloudflare challenge, etc.) | `false` |
| `consent_wall_unresolved` | A cookie-consent wall was detected and could not be dismissed | `false` |
| `thin_content` | Extracted content below the minimum usable length | `false` |
| `summary_failed` | The `webclip-summary` preset call failed or returned invalid output after its repair round-trip | `true` |
| `audit_red` | Ghost-audit verdict is `red` and the caller lacks `webclip.save.force` | `false` (needs a different, privileged caller) |
| `slug_conflict` | A note with that slug already exists | `false` |
| `operation_not_found` | Unknown or expired `operationId` | `false` |
| `operation_already_saved` | That operation was already consumed | `false` |
| `forbidden` | ACL denied the operation for this principal | `false` |

## Decision 8 — `save` takes no content, only an `operationId`

`save` does not accept `edits` (title/summary/tags/body overrides). The
audit verdict `compose` returns is computed against one specific text; if
`save` could rewrite that text on the way out, the stored verdict would
stop describing what actually gets committed — an edit could reintroduce a
violation (drop a source, add an aphoristic closer) and it would sail
through under a `green` that no longer applies to it. That is a real
audit-bypass path, distinct from — and unintentional, unlike —
`webclip.save.force`.

The alternative (re-auditing the edited text before allowing save) was
considered and rejected for now: it adds a second LLM round-trip to a path
that's supposed to be cheap, for a case (touching up a draft) that a fresh
`compose` call already covers at the same cost. **If the draft needs a
change — a different title, a related note to link, anything — call
`compose` again.** It's cheap, it always returns a freshly audited
`operationId`, and the stale one simply expires unused. This also settles
where `relatedNotes` belongs: only as `compose` input, never patched onto
an existing operation. Wanting to add links after seeing an initial draft
just means calling `compose` again with `relatedNotes` filled in — no
separate patch endpoint needed.

## Decision 9 — `save` can commit itself, or hand the content back for the caller to commit

Default behavior (`mode: "commit"`, the implicit default) is what's
documented below: the service writes into its own `vault/`, commits, and
pushes. That's right for a single, one-off save — the interactive skill
calling this API for one webclip, or `Claudinho` doing the same.

It's wrong for batch processing. The existing backlog-import playbook
(`add-scholion-webclip/batch-playbook.md`) already deliberately avoids a
commit per note — dozens or hundreds of webclips landing as individual
commits was already called "indecent" for the repo's history, so that
playbook has the orchestrator accumulate everything a batch of subagents
produced and commit once, on a timer, for the whole window. A `save` that
always commits immediately would force that same choice back onto every
caller doing batch work: either call this API and get the commit flood
back, or bypass it and reimplement extraction by hand again — defeating
the point of building this service at all.

`mode: "return"` is the other option: `save` still validates the operation
and still enforces the same audit gate (verdict must be green/yellow, or
the caller needs `webclip.save.force` for red — identical authorization
either way, only the persistence mechanism changes). But instead of writing
into its own `vault/` and committing, it hands back the two fully-assembled
file bodies as strings — the same content `mode: "commit"` would have
written, already through frontmatter assembly, slug/date/sources
resolution, everything. Nothing touches git. The caller decides where and
when those two files actually land: an orchestrator collecting many
`mode: "return"` saves across a batch window and committing them together
in its own checkout, or the interactive skill writing them straight into
the human's live `E:\scholion` working tree for one last look before a
commit the human runs themselves.

The operation is consumed in both modes — the decision "this is good,
finalize it" was already made either way; `mode` only changes who performs
the write.

## What `save` writes (`mode: "commit"`)

Two files, one commit:

```
clippings/<YYYY-MM>/<domain>--<slug>.md      the raw capture, verbatim
content/notes/<slug>.md                       the composed webclip note
```

`<YYYY-MM>` is the month `compose` ran, not `save` time — a `compose` that
sits near its TTL and gets saved the next day still files under the month
it was actually captured. `<domain>` is the host with `www.` stripped and
dots turned into hyphens (`martinfowler.com` → `martinfowler-com`), same
convention the interactive skill already uses.

**Clipping** (`clippings/`) — frontmatter only, body is the extracted
Markdown verbatim:

```yaml
---
url: "<original url>"
captured_at: "<compose timestamp, ISO with offset>"
title: "<captured title>"
domain: "<domain, no www.>"
---
```

**Note** (`content/notes/`) — the fields `compose` returned
(`title`/`summary`/`tags`/`body`/`language`), plus `category: webclip`,
`has_commentary: false`, and a `sources` block with two entries: the
original URL and the archived-clipping link. That link is built from the
fixed path convention regardless of `mode` (see Decision 9) — it resolves
once whoever ends up committing the clipping actually pushes it, whether
that's this same call (`mode: "commit"`) or a later one done by the caller
(`mode: "return"`):

```yaml
---
title: "<from compose>"
date: "<compose timestamp>"
category: webclip
summary: "<from compose>"
tags: [<from compose>]
has_commentary: false
sources:
  - title: "<page title>"
    url: "<original url>"
    kind: article   # inferred from domain, same table the interactive skill uses
  - title: "Raw clipping (archived copy)"
    url: "https://github.com/thluiz/scholion/blob/main/clippings/<YYYY-MM>/<file>.md"
    kind: repo
---
<body, from compose>
```

Both files land in the same commit precisely because of that
archived-copy link: a note that references a clipping which isn't in the
same commit (or an earlier one) would point at a 404 for however long the
gap lasted. One commit means the link is never dangling even for a moment.

## Endpoints (draft)

```
GET  /health                              no key required
GET  /me                                  what your key may do

POST /webclip/compose                     {url} or {text,title,url,domain}, relatedNotes?
  → { operationId, clipping, note, audit: {verdict, findings, summary}, expiresAt }

GET  /webclip/{operationId}               poll a pending operation

POST /webclip/{operationId}/save          { mode?: "commit" | "return", force?: boolean }
  → mode "commit" (default): { slug, notePath, clippingPath, commit: {...} }
  → mode "return":            { slug, notePath, clippingPath, clippingContent, noteContent, commit: null }

DELETE /webclip/{operationId}             discard explicitly (optional; also expires on its own)
```

## Deployment

Same HermesTools host as `vox-intelligence` and `scholion-places`, same
reverse-proxy-stamps-the-`X-Api-Key` pattern, before writing the systemd
unit — not yet done.
