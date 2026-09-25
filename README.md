# prifly-ext-sentry

A [prifly](https://github.com/jimmy927/prifly) extension that puts your Sentry
issues into the window. **From a Sentry issue…**, beside New session, lays out
the unresolved issues of the projects you mapped, in Sentry's own triage
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
   Create a new token with **Issue & Event: Read & Write**, **Project: Read**
   and **Organization: Read** (read-only works too; resolving from the chip then
   fails with a 403).
2. **Paste the token Sentry shows you** — one paste, once. It is checked
   against Sentry there and then and kept in `auth.json` in this folder,
   readable only by you.
3. **Choose an organization**, then **map a project to its checkout** — pick
   the project and type the folder it is checked out in (for a project called
   `odi` it suggests `~/odi` or `~/src/odi` when that is a git checkout; leave
   the field empty to take the suggestion).

If you already use `sentry-cli`, there is nothing to paste: a token in
`SENTRY_AUTH_TOKEN` (in the environment prifly's host starts with) or in
`~/.sentryclirc` (`sentry-cli login`) is used as it is, and the organization in
`~/.sentryclirc`'s `[defaults]` is taken too. The chooser never asks for a
token in any other way, and sessions are told never to ask for one.

The rows kept beside the issues change any of it later: **Sort by events / last
seen**, **Map a project…**, **Switch organization…**, **Log out of Sentry**
(which deletes `auth.json`; a token from `SENTRY_AUTH_TOKEN` or
`~/.sentryclirc` is sentry-cli's, and stays).

## config.json

Written by the setup rows; edit it by hand if you like
(`config.example.json` shows every field):

```json
{
  "org": "morpheus-0r",
  "baseUrl": "https://sentry.io",
  "projects": { "odi": "/home/jimmy/odi" },
  "query": "is:unresolved",
  "period": "14d",
  "sort": "date",
  "refreshSeconds": 120
}
```

- `projects` — Sentry project slug → the checkout its sessions start in. Every
  mapped project's issues are listed; `~` is expanded.
- `query` — Sentry search syntax for the list (`is:unresolved level:error`,
  `is:unresolved !browser.name:Edge`, …).
- `period` — how recently an issue must have been seen to be listed.
- `sort` — `date` (last seen), `new` (first seen), `freq` (events) or `user`
  (users affected).
- `baseUrl` — for a self-hosted Sentry.

`config.json`, `auth.json`, `state.json` and the saved `issues/` are all ignored
by git: nothing about your account or your errors is ever committed.

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
