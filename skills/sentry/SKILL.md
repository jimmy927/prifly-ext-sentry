---
name: sentry
description: For a terminal outside prifly only (the reader sets SENTRY_AUTH_TOKEN): search Sentry issues, read an issue with its latest event and stack trace, list an issue's events, save an event's full JSON, and resolve or archive an issue when explicitly asked. Inside a prifly session do NOT use this — call the sentry_search, sentry_issue, sentry_events and sentry_event tools instead. Use when the user mentions a Sentry issue (PROJ-1A2, a sentry.io/issues/… link), asks what is erroring in production, or wants the stack trace, breadcrumbs or request behind an error.
---

## Sentry

**In a prifly session, use the `sentry_*` tools, not this skill.** The Sentry extension serves them to every session and reads with the reader's own login, so no session handles a token:

- `sentry_search` — Sentry search syntax (`is:unresolved` is added unless the query has an `is:`); options `project`, `sort`, `period`, `limit`.
- `sentry_issue` — one issue (short id `PROJ-1A2`, numeric id or issue URL): status, counts, notes and its latest event (in-app frames, breadcrumbs, request, tags).
- `sentry_events` — an issue's events, newest first.
- `sentry_event` — one event (`latest`, `oldest`, `recommended` or an event id); `save` writes the whole event JSON to your scratchpad and returns the path.
- `sentry_replay` — a session replay (an event's `replayId` tag, or a replay URL) as a timeline of navigations, clicks, network calls, console lines and DOM changes, extension and translator traces flagged; `around` an ISO time narrows it, `save` writes the raw segments.

All take an optional `org`. They only read: resolving and archiving are done from the issue's chip on the session banner. If a tool says Sentry is not logged in, tell the reader to log in from “From a Sentry issue…”; never ask for a token in chat.

The rest of this file is for a terminal outside prifly (a Claude Code plugin install), where `sentry.py`, which sits next to this SKILL.md, does the same from the command line. Standard library only.

The token comes only from the environment: the reader sets `SENTRY_AUTH_TOKEN` (or `SENTRY_TOKEN`) themselves. The organization comes from `--org`, `SENTRY_ORG`, then the Sentry extension's settings in prifly's database if prifly is installed on the machine; the address likewise from `--base-url`, `SENTRY_URL`, then those settings (with the default sentry.io, the data region the extension stored, such as de.sentry.io for an EU organization). If the script says `SENTRY_TOKEN` is not set, say so and stop — never ask the user for a token in chat, and do not go looking for tokens elsewhere.

### Commands

```bash
# Search (Sentry search syntax; is:unresolved is added unless the query has an is:)
python3 <this skill's folder>/sentry.py search "Failed to fetch"
python3 <this skill's folder>/sentry.py search --project odi --sort freq --limit 10
python3 <this skill's folder>/sentry.py search "is:resolved release:abc123" --period 30d
python3 <this skill's folder>/sentry.py search "level:fatal" --json

# One issue: status, counts, notes, and its latest event (in-app frames, breadcrumbs, request, tags)
python3 <this skill's folder>/sentry.py issue PROJ-1A2
python3 <this skill's folder>/sentry.py issue https://your-org.sentry.io/issues/7291288169/

# An issue's events, newest first — to see whether it is one user, one release, one host
python3 <this skill's folder>/sentry.py events PROJ-1A2 --limit 20

# One event: latest (default), oldest, recommended, or an event id
python3 <this skill's folder>/sentry.py event PROJ-1A2 oldest
python3 <this skill's folder>/sentry.py event PROJ-1A2 3f9c1e7a5b2d4c8e9a0b6d1f7e3c5a42 --full   # every frame
python3 <this skill's folder>/sentry.py event PROJ-1A2 --out sentry-PROJ-1A2.json            # whole JSON, for jq

# Writes — ONLY when the user explicitly asked for this issue to be resolved / archived / reopened
python3 <this skill's folder>/sentry.py resolve PROJ-1A2
python3 <this skill's folder>/sentry.py ignore PROJ-1A2      # archive until it escalates
python3 <this skill's folder>/sentry.py unresolve PROJ-1A2
```

Issues are accepted as a short id (`PROJ-1A2`), a numeric id, or an issue URL (`https://your-org.sentry.io/issues/1234567890/`).

### How to work an issue

1. `issue <id>` — read the title, culprit, counts and the latest event's in-app frames.
2. When the trimmed trace is not enough, `event <id> --out <file>` and read the frames' `context` and `vars`, and every breadcrumb, from the JSON.
3. `events <id>` when it matters whether the error is new in a release, tied to one user, or everywhere.
4. Find the cause in the code before proposing a fix.

(The same steps with the tools: `sentry_issue`, then `sentry_event` with `save`, then `sentry_events`.)

### Rules

- Reading is free; **resolving, archiving and reopening are writes**. Do them only when the user asked for that specific issue in this conversation — never as a tidy-up after a fix. In prifly the issue's chip on the session banner does this for the user.
- Sentry events can carry personal data (emails, IPs, request bodies). Quote only what the task needs.
