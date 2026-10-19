---
name: sentry
description: Search Sentry issues, read an issue with its latest event and stack trace, list an issue's events, save an event's full JSON, and resolve or archive an issue when explicitly asked. Use when the user mentions a Sentry issue (PROJ-1A2, a sentry.io/issues/… link), asks what is erroring in production, or wants the stack trace, breadcrumbs or request behind an error.
---

## Sentry

Wraps `sentry.py`, which sits next to this SKILL.md: run it as `python3 <this skill's folder>/sentry.py` through `vault_run` (entry `sentry`). Standard library only.

Credentials come from the reader's own Sentry login. In prifly it is filed in the vault as the entry `sentry` (the token they pasted into "From a Sentry issue…"): **run the script through the `vault_run` tool with `entry: "sentry"`**, which hands the token over as `SENTRY_TOKEN` (the vault names an api-token entry's variable after the entry; `SENTRY_AUTH_TOKEN` works too). The token comes only from the environment (`SENTRY_TOKEN` or `SENTRY_AUTH_TOKEN`); outside prifly (a terminal plugin install) the reader sets `SENTRY_AUTH_TOKEN` themselves. The organization comes from `--org`, `SENTRY_ORG`, then the extension's settings in prifly's database; the address likewise from `--base-url`, `SENTRY_URL`, then those settings (with the default sentry.io, the organization's data region the extension stored in prifly's database, such as de.sentry.io for an EU organization). When the session's first message names `--org`/`--base-url` flags, pass them before the subcommand. If the script says `SENTRY_TOKEN` is not set, say so and stop — never ask the user for a token in chat, and do not go looking for tokens elsewhere.

In prifly, a session started from a Sentry issue already has that issue in its first prompt and the whole latest event saved as JSON on disk (the prompt names the file): read that file before calling the API again. Use this skill for other issues, other events of the same issue, and searching.

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

### Rules

- Reading is free; **resolving, archiving and reopening are writes**. Do them only when the user asked for that specific issue in this conversation — never as a tidy-up after a fix. In prifly the issue's chip on the session banner does this for the user.
- Sentry events can carry personal data (emails, IPs, request bodies). Quote only what the task needs.
