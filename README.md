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

Once this repository is on GitHub: in prifly, status bar → the puzzle icon →
Install from `https://github.com/jimmy927/prifly-ext-sentry`, then tick it to
enable it.

Until then, or instead, clone it into prifly's extensions folder and enable it
from the same puzzle-icon list:

```sh
git clone /home/jimmy/src/prifly-ext-sentry ~/.local/share/prifly/extensions/prifly-ext-sentry
```

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
   against Sentry there and then and kept in `auth.json` in this folder,
   readable only by you.
3. **Choose an organization** — and that is all. Every project in it is
   listed, including ones made in Sentry later; there are no projects to map.

## Where a session starts

Nothing to configure: when you start a session from an issue, its folder is
worked out then (`checkout.ts`). Sentry knows which repository a project's
code is in — its **code mappings**, under Settings → Integrations → GitHub (or
GitLab…) → Code Mappings — and this machine knows where that repository is
checked out. Looked for in this order:

1. a folder pinned to the project in `config.json`'s `projects` (optional);
2. the checkout the project's last session ran in (remembered in `state.json`);
3. the checkout behind any folder a prifly session on this machine runs in;
4. a checkout in `~`, `~/src` or `~/code` whose git remote is the repo — a
   hand-made mapping of the whole stack wins over ones Sentry generated;
5. without a code mapping, `~/<slug>`, `~/src/<slug>` or `~/code/<slug>` when
   that is a git checkout.

Found nowhere, the issue's card says why ("no code mapping in Sentry for web:
you pick the folder") and prifly's New session form asks for the folder. The
checkout you pick there is remembered for that project's next session. Give a
project a code mapping in Sentry and none of this is needed.

If you already use `sentry-cli`, there is nothing to paste: a token in
`SENTRY_AUTH_TOKEN` (in the environment prifly's host starts with) or in
`~/.sentryclirc` (`sentry-cli login`) is used as it is, and the organization in
`~/.sentryclirc`'s `[defaults]` is taken too. The chooser never asks for a
token in any other way, and sessions are told never to ask for one.

The rows kept beside the issues change any of it later: **Sort by events / last
seen**, **Switch organization…**, **Log out of Sentry**
(which deletes `auth.json`; a token from `SENTRY_AUTH_TOKEN` or
`~/.sentryclirc` is sentry-cli's, and stays).

## config.json

Written by the setup rows; edit it by hand if you like
(`config.example.json` shows every field):

```json
{
  "org": "morpheus-0r",
  "baseUrl": "https://sentry.io",
  "projects": {},
  "query": "is:unresolved",
  "period": "14d",
  "sort": "date",
  "refreshSeconds": 120,
  "startSessions": { "enabled": false, "levels": ["fatal", "error"], "maxPerDay": 10, "maxAgeHours": 24 }
}
```

- `projects` — optional: Sentry project slug → a folder its sessions always
  start in, over whatever is found (`~` is expanded). Usually empty. It no
  longer decides which projects are listed: all of them are.
- `query` — Sentry search syntax for the list (`is:unresolved level:error`,
  `is:unresolved !browser.name:Edge`, …).
- `period` — how recently an issue must have been seen to be listed.
- `sort` — `date` (last seen), `new` (first seen), `freq` (events) or `user`
  (users affected).
- `baseUrl` — for a self-hosted Sentry.
- `startSessions` — see below; off unless you turn it on.

`config.json`, `auth.json`, `state.json` and the saved `issues/` are all ignored
by git: nothing about your account or your errors is ever committed.

## Starting sessions by itself

With it turned on, each new error nobody works on becomes a session without
a click. Turn it on in prifly's Extensions page: unfold "Sentry issues" and
tick **Start sessions by itself**, with the **Levels** that count, the
**Most per day** and **Newest errors only (hours)**. A prifly without
extension settings reads the same from `config.json` instead:

```json
"startSessions": { "enabled": true, "levels": ["fatal", "error"], "maxPerDay": 10, "maxAgeHours": 24 }
```

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
- **A chip on the session** — `ODI-GC6: AssertionError: No ref for…`, its
  status (and substatus), level, counts and last seen on hover. It links to the
  issue, and its menu resolves it, archives it until it escalates, or reopens
  it. It keeps showing the issue's current status after it leaves the
  unresolved list.
- **A Claude Code skill** — `skills/sentry`: search issues, read an issue and
  its latest event, list its events, save an event's JSON, and resolve /
  archive / reopen when asked. Same login, standard-library Python. The
  repository is also a Claude Code plugin and its own marketplace, so terminal
  sessions can have it too:

      claude plugin marketplace add jimmy927/prifly-ext-sentry
      claude plugin install sentry@prifly-ext-sentry

- **Instructions** — `prompt.md`, added to every session prifly starts: the
  event JSON is on disk, leave resolving to the reader, never ask for a token.

## How an issue finds its session

prifly hands the extension the id of the session a launch became, and the pair
is kept in `state.json`. An issue therefore belongs to the session that was
started from it.

## Working on it

```sh
bun install
bun test          # unit tests; the live ones skip without a token
bun run typecheck
bun run check     # biome, with prifly's limits
SENTRY_AUTH_TOKEN=sntryu_… SENTRY_LIVE_ORG=morpheus-0r SENTRY_LIVE_PROJECT=odi bun test live   # GET only
```

`prifly-api.ts` is a copy of prifly's extension contract
(`apps/desktop-host/src/extensions/api.ts`), kept here so the repository
type-checks on its own.
