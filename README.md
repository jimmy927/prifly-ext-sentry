# prifly-ext-sentry

A [prifly](https://github.com/jimmy927/prifly) extension that puts your Sentry
issues into the window. **From a Sentry issue…**, beside New session, lays out
the unresolved issues of every project in your organization, in Sentry's own triage
columns (New, Escalating, Regressed, Ongoing), sorted by when they were last
seen or by how many events they have. The issue you pick becomes a session in
that project's checkout that already knows the issue: the counts, first and
last seen, releases, tags, the latest event's stack trace with your own frames
in front, the breadcrumbs, the request, and the whole latest event saved as
JSON beside the prompt. The issue then rides along on that session's banner:
click it to open it in Sentry, or use its menu to resolve or archive it when
the work is done.

It is the Sentry twin of
[prifly-ext-trello](https://github.com/jimmy927/prifly-ext-trello) and is built
the same way.

## Install

Needs a prifly with extension **settings**, **state** and the **vault** (its
"vault-file" feature). When one of the three is missing the list shows a single
row, "Update prifly to use this extension", and nothing else runs: no refresh,
no Sentry calls.

**Upgrading from an earlier version?** The token used to be kept in `auth.json`
in this folder (or read from `SENTRY_AUTH_TOKEN` / `~/.sentryclirc`), and the
choices in `state.json` / `config.json`. None of these is read any more, so you
log in once again: open **From a Sentry issue…** and paste a token (below); it
goes straight into the vault. Delete the old `auth.json` and `state.json`
yourself. Your settings are on the Extensions page and are not affected; links
from sessions to issues made before `api.state` are not carried over.

In prifly: status bar → the puzzle icon → Install from
`https://github.com/jimmy927/prifly-ext-sentry`, then tick it to enable it.

Or clone it into prifly's extensions folder and enable it from the same
puzzle-icon list:

```sh
git clone https://github.com/jimmy927/prifly-ext-sentry ~/.local/share/prifly/extensions/prifly-ext-sentry
```

That is prifly's data folder on Linux and WSL; on macOS it is
`~/Library/Application Support/prifly/extensions/`, on Windows
`%LOCALAPPDATA%\prifly\host\extensions\`.

There is nothing to install for it to run — prifly's host imports `index.ts`
with Bun, and the extension has no runtime dependencies. `bun install` is only
for working on it (tests, type-check, lint).

## Log in

Sentry has no "approve this app" page for a desktop tool, so this extension
logs in the way `sentry-cli` does: with a **personal auth token** you make
yourself, on Sentry's own page, signed in however you normally are. prifly
never sees a password, and the token reaches your organizations and nobody
else's.

Open **From a Sentry issue…** and follow the rows it shows:

1. **Open Sentry's auth token page** — your browser opens
   [sentry.io/settings/account/api/auth-tokens](https://sentry.io/settings/account/api/auth-tokens/).
   "Create New Token" lists a Name field and one permission dropdown per
   category, in this order — fill in exactly this, and the chooser repeats it
   on the row and again once the page is open:

   | Field | Value | Why |
   |---|---|---|
   | Name | `prifly` | so you recognize it later on that same page |
   | Project | Read | lists the projects' issues |
   | Team | No Access | nothing here calls a team endpoint |
   | Release | No Access | releases come embedded in issue and event data (`firstRelease`, `lastRelease`, the `release` tag) — nothing calls Sentry's own releases endpoint |
   | Issue & Event | Read & Write | reads issues and events, and **Read & Write** is what lets the chip's menu resolve, archive or reopen one — Read alone works for everything else, and those actions then fail with a 403 |
   | Organization | Read | lists your organizations, is what `/auth/` (the token check) needs, and reads the code mappings that suggest a project's checkout |
   | Member | No Access | nothing here calls a member endpoint |
   | Alerts | No Access | nothing here calls an alert-rule endpoint |

   A token that is missing a permission a call needs fails with Sentry's own
   403, and the extension's error (and the `sentry.py` skill's) names which
   permission to raise.
2. **Paste the token Sentry shows you** — one paste, once. It is checked
   against Sentry there and then and kept in **prifly's vault** (the entry
   `sentry`; prifly shows you a card to confirm it, and the token travels with
   prifly's data). It is never written to a file.
3. **Choose an organization** — and that is all. Every project in it is
   listed, including ones made in Sentry later; there are no projects to map.

## Where a session starts

Nothing to configure: when you start a session from an issue, its folder is
worked out then (`checkout.ts`). Sentry knows which repository a project's
code is in — its **code mappings**, under Settings → Integrations → GitHub (or
GitLab…) → Code Mappings — and this machine knows where that repository is
checked out. Looked for in this order:

1. a folder pinned to the project in the **Project folders** setting
   (optional);
2. the checkout the project's last session ran in (remembered in prifly's
   database, see below);
3. the checkout behind any folder a prifly session on this machine runs in;
4. a checkout in `~`, `~/src` or `~/code` whose git remote is the repo — a
   hand-made mapping of the whole stack wins over ones Sentry generated;
5. without a code mapping, `~/<slug>`, `~/src/<slug>` or `~/code/<slug>` when
   that is a git checkout.

Found nowhere, the issue's card says why ("no code mapping in Sentry for web:
you pick the folder") and prifly's New session form asks for the folder. The
checkout you pick there is remembered for that project's next session. Give a
project a code mapping in Sentry and none of this is needed.

The token is read from one place only: the vault entry `sentry`. Neither
`SENTRY_AUTH_TOKEN` nor `~/.sentryclirc` (`sentry-cli`'s) is looked at, and
neither is the organization in them: choose it in the chooser or on the
Extensions page. Sessions are told never to ask for a token.

The rows kept beside the issues change any of it later: **Sort by events / last
seen**, **Switch organization…**, **Log out of Sentry** (which removes the
vault entry; an entry you made yourself in the vault is yours to remove).

If the vault card is declined, left unanswered or refused, nothing is saved and
the row says so; the token is filed at level 1, the only one the extension can
read. If Sentry later refuses the saved token (revoked, expired), the list shows
"Sentry refused the saved token" with the login rows again: paste a new one, or
log out. The token is never written to prifly's log or shown in a message.

## Settings and what the extension remembers

This extension keeps no settings or state in files in its folder. The plain
settings live in prifly's Extensions page (unfold "Sentry issues"): **Sentry
organization**, **Sentry address**, **Project folders**, **Search**, **Seen
within**, **Sort by**, **Refresh every** and the auto-start ones below. prifly
keeps them with its own data, so they move with it to another host. On a
Windows host, set the project folder once there, as `slug=folder` pairs
separated by `;` (`shop=C:\Users\you\src\shop`).

- **Project folders** — optional: Sentry project slug → a folder its sessions
  always start in, over whatever is found (`~` is expanded). Usually empty. It
  does not decide which projects are listed: all of them are.
- **Search** — Sentry search syntax for the list (`is:unresolved level:error`,
  `is:unresolved !browser.name:Edge`, …).
- **Seen within** — how recently an issue must have been seen to be listed.
- **Sort by** — `date` (last seen), `new` (first seen), `freq` (events) or
  `user` (users affected).
- **Sentry address** (Base URL) — only for a self-hosted Sentry: set it here
  **before** you log in, and the extension uses it for everything. Leave it at
  `https://sentry.io` for Sentry's hosted service.

### Data regions (EU and US)

Sentry's hosted service keeps each organization in a data region: EU
organizations are on `https://de.sentry.io`, US ones on `https://us.sentry.io`.
When you pick an organization, the extension reads its region from Sentry's
organization list (`links.regionUrl`), keeps it in prifly's database beside the
choice, and sends that organization's requests there. An organization picked
before this was kept, or set on the Extensions page, is looked up once and
stored. Nothing needs setting. A **Sentry address** other than `sentry.io` (a
self-hosted Sentry) always wins over the region, and links to issues open at the
address Sentry itself gives for them.

The `sentry` skill uses the same region: a session started from an issue passes
it as `--base-url`, and the script on its own reads the stored one from prifly's
database (`extension_state`, document `choices`). It finds that database at
`$PRIFLY_DB`, else in prifly's data folder: `$XDG_DATA_HOME/prifly` or
`~/.local/share/prifly` (Linux, WSL), `~/Library/Application Support/prifly`
(macOS), `%LOCALAPPDATA%\prifly\host` (Windows). Run natively on Windows, the
skill needs Python 3 there; run inside WSL it reads the WSL copy.

What the extension remembers lives in prifly's database too (`api.state`), not
in files:

- the organization and sort you pick in the chooser (**Switch organization…**,
  **Sort by events / last seen**) — a document called `choices`. A pick stands
  until you change that setting on the Extensions page; a setting changed after
  a pick wins over it;
- which session was started from which issue, and which folder each project's
  sessions were last started in — a document called `state`.

The only files it writes are the saved `issues/`, ignored by git: nothing about
your account or your errors is ever committed.

## Starting sessions by itself

With it turned on, each new error nobody works on becomes a session without
a click. Turn it on in prifly's Extensions page: unfold "Sentry issues" and
tick **Start sessions by itself**, with the **Levels** that count, the
**Most per day** and **Newest errors only (hours)**.

On every refresh, each open issue whose level is in `levels` and that no
session carries yet is started, oldest first seen first, at most three a
refresh and `maxPerDay` in any 24 hours. Only fresh errors count: an issue
last seen more than `maxAgeHours` (default 24) ago, or whose last-seen time
can't be read, is left alone. Each issue is asked for once a day,
whatever prifly answers, so one it refused is not asked for again on every
refresh. prifly has caps of its own on top: at most 3 of these sessions
still working at once, and 12 started an hour.

The session starts as Research: it investigates and proposes, and changes
nothing until you say Act. Its row is tinted in the sidebar until you open
it, and the Sentry issue is on its banner as with any other start. Starting
by itself needs a prifly with `api.start` (its `start-session` feature); an
older one leaves the launcher glowing as before and starts nothing.

An issue whose project has no folder found (no code mapping, no checkout)
is not started: the New session form would have asked for the folder.

## What it brings

- **A launcher** (`index.ts`, `setup.ts`, `issue-face.ts`) — the issues as a
  board. Click one to read it over the board; start a session from it with its
  button, its right-click menu or a double-click; resolve or archive it from
  its right-click menu; filter by title, culprit, short id, level or project.
- **The first prompt** (`issue-prompt.ts`, `stack.ts`, `event.ts`) — the issue
  and its latest event as Markdown: facts, exception chain (raised exception
  first, then its causes), each trace with in-app frames kept, runs of library
  frames folded to a count, the raising frame always kept, and the innermost
  in-app frame shown with its source and local variables; the last 15
  breadcrumbs; the request (method, URL, query, a few headers, body — never
  cookies); contexts; the tags the rest does not already say. The issue and
  the event are saved whole as `issues/<SHORT-ID>/issue.json` and
  `issues/<SHORT-ID>/event-<id>.json`, and the prompt says where.
- **A chip on the session** — `PROJ-1A2: AssertionError: No ref for…`, its
  status (and substatus), level, counts and last seen on hover. It links to the
  issue, and its menu resolves it, archives it until it escalates, or reopens
  it. It keeps showing the issue's current status after it leaves the
  unresolved list.
- **A Claude Code skill** — `skills/sentry`: search issues, read an issue and
  its latest event, list its events, save an event's JSON, and resolve /
  archive / reopen when asked. In prifly it uses the same login: sessions run
  it through `vault_run` with the entry `sentry`, which sets `SENTRY_TOKEN`.
  Standard-library Python. The repository is also a Claude Code plugin and its
  own marketplace, so terminal sessions can have it too; there, set
  `SENTRY_AUTH_TOKEN` to your Sentry token:

      claude plugin marketplace add jimmy927/prifly-ext-sentry
      claude plugin install sentry@prifly-ext-sentry

- **Instructions** — `prompt.md`, added to every session prifly starts: the
  event JSON is on disk, leave resolving to the reader, never ask for a token.

## How an issue finds its session

prifly hands the extension the id of the session a launch became, and the pair
is kept in prifly's database (`api.state`). An issue therefore belongs to the session that was
started from it.

## Working on it

```sh
bun install
bun test          # unit tests; the live ones skip without a token
bun run typecheck
bun run check     # biome, with prifly's limits
SENTRY_AUTH_TOKEN=sntryu_… SENTRY_LIVE_ORG=your-org SENTRY_LIVE_PROJECT=your-project bun test live   # GET only
```

`prifly-api.ts` is a copy of prifly's extension contract
(`apps/desktop-host/src/extensions/api.ts`), kept here so the repository
type-checks on its own.

## License and contributing

Source-available under the Functional Source License 1.1 with an Apache 2.0 future license (`LICENSE.md`): use it, change it and fix it freely, but not to offer a competing product. Each version becomes Apache 2.0 two years after its release.

Pull requests are welcome. Before one can be merged, its author signs the contributor agreement (`CLA.md`), which assigns the copyright in the contribution to The Startup Factory AB; the CLA bot asks for it on the pull request.
