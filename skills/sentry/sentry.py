#!/usr/bin/env python3
"""
Sentry CLI for Claude Code sessions: search issues, read an issue and an
event, list an issue's events, and resolve / archive / reopen an issue.

The token comes only from the environment: SENTRY_TOKEN or SENTRY_AUTH_TOKEN.
The reader's login lives in prifly's vault as the entry "sentry" (the token they
pasted into prifly's "From a Sentry issue…"): run this script through the
vault_run tool with entry "sentry", which hands the token over as SENTRY_TOKEN
(the name the vault gives an api-token entry called "sentry"). Outside prifly
set SENTRY_AUTH_TOKEN yourself.

The organization and address: --org / --base-url, SENTRY_ORG / SENTRY_URL, then
the Sentry extension's settings in prifly's database (read-only). Standard
library only.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sqlite3
import sys
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path, PurePosixPath, PureWindowsPath
from typing import Any

HOME = Path.home()


def prifly_data_dir(platform: str | None = None, env: dict[str, str] | None = None, home: str | Path | None = None) -> str:
    """Where prifly keeps its per-user data, as the host decides it (apps/desktop-host/src/platform/data-dir.ts).

    Linux and WSL: $XDG_DATA_HOME/prifly (~/.local/share/prifly when unset);
    macOS: ~/Library/Application Support/prifly;
    Windows: %LOCALAPPDATA%\\prifly\\host (~\\AppData\\Local when unset).
    prifly sets no environment variable naming this folder for its sessions;
    only PRIFLY_DB (see prifly_db), which the host itself reads, can point elsewhere.
    """
    platform = sys.platform if platform is None else platform
    env = dict(os.environ) if env is None else env
    home = HOME if home is None else home
    if platform == "win32":
        local = env.get("LOCALAPPDATA") or str(PureWindowsPath(str(home), "AppData", "Local"))
        return str(PureWindowsPath(local, "prifly", "host"))
    if platform == "darwin":
        return str(PurePosixPath(str(home), "Library", "Application Support", "prifly"))
    xdg = env.get("XDG_DATA_HOME")
    return str(PurePosixPath(xdg or str(PurePosixPath(str(home), ".local", "share")), "prifly"))


def prifly_db(platform: str | None = None, env: dict[str, str] | None = None, home: str | Path | None = None) -> str:
    """prifly's database file: $PRIFLY_DB when set, else prifly.db in its data folder."""
    env = dict(os.environ) if env is None else env
    if env.get("PRIFLY_DB"):
        return env["PRIFLY_DB"]
    if (sys.platform if platform is None else platform) == "win32":
        return str(PureWindowsPath(prifly_data_dir(platform, env, home), "prifly.db"))
    return str(PurePosixPath(prifly_data_dir(platform, env, home), "prifly.db"))


def prifly_setting(field: str) -> str:
    """A text setting of the prifly Sentry extension, read from prifly's database.

    Read-only; any failure (no file, locked, no row, bad JSON) gives "".
    """
    row = db_value("select value from settings where key = 'prifly.extensions.settings.sentry'")
    found = row.get(field) if isinstance(row, dict) else None
    return found.strip() if isinstance(found, str) else ""


def db_value(query: str) -> Any:
    """The JSON in the first column of the query's first row of prifly's database, opened read-only; None on any failure."""
    try:
        path = Path(prifly_db())
        uri = path.as_uri() if path.is_absolute() else f"file:{urllib.parse.quote(str(path))}"
        con = sqlite3.connect(f"{uri}?mode=ro", uri=True, timeout=1)
        try:
            row = con.execute(query).fetchone()
        finally:
            con.close()
        return json.loads(row[0]) if row else None
    except (sqlite3.Error, ValueError, TypeError, OSError):
        return None


def stored_region(org: str) -> str:
    """The data region (https://de.sentry.io) the extension kept for this organization in prifly's database, or ""."""
    choices = db_value(
        "select value from extension_state where extension_id = 'sentry' and name = 'choices'"
    )
    regions = choices.get("regions") if isinstance(choices, dict) else None
    found = regions.get(org) if isinstance(regions, dict) else None
    return found.strip() if isinstance(found, str) else ""


def settings(org_flag: str | None, base_flag: str | None = None) -> tuple[str, str, str]:
    """The API root, the token and the organization."""
    token = os.environ.get("SENTRY_AUTH_TOKEN") or os.environ.get("SENTRY_TOKEN")
    if not token:
        sys.exit(
            "SENTRY_TOKEN is not set. Inside prifly, run this script through the vault_run "
            "tool with entry \"sentry\" (log in first from \"From a Sentry issue…\"). Outside "
            "prifly, set SENTRY_AUTH_TOKEN (or SENTRY_TOKEN) to your Sentry token."
        )
    base = base_flag or os.environ.get("SENTRY_URL") or prifly_setting("baseUrl")
    org = org_flag or os.environ.get("SENTRY_ORG") or prifly_setting("org")
    if not org:
        sys.exit("no Sentry organization: pass --org, or choose it in prifly's Extensions dialog (Sentry issues), or set SENTRY_ORG")
    base = (base or "https://sentry.io").rstrip("/")
    if base == "https://sentry.io":
        # The default address: the organization's data region, when the extension kept one (an EU organization is on de.sentry.io).
        base = stored_region(org).rstrip("/") or base
    return base + "/api/0", token, org


def needed_permission(method: str, path: str) -> str:
    """Which of Sentry's token permissions a call needs, for a 403's message.

    Mirrors auth.ts's neededPermission: the organization and project-list
    paths are checked first, then the method falls back to an issue or event.
    """
    if path == "/auth/" or path == "/organizations/":
        return "Organization: Read"
    if re.fullmatch(r"/organizations/[^/]+/projects/", path):
        return "Project: Read"
    if method == "PUT":
        return "Issue & Event: Read & Write"
    return "Issue & Event: Read"


class Api:
    def __init__(self, root: str, token: str, org: str) -> None:
        self.root, self.token, self.org = root, token, org

    def call(self, method: str, path: str, params: dict[str, str] | None = None, body: Any = None) -> Any:
        url = self.root + path + ("?" + urllib.parse.urlencode(params) if params else "")
        data = None if body is None else json.dumps(body).encode()
        headers = {"Authorization": f"Bearer {self.token}"}
        if data is not None:
            headers["Content-Type"] = "application/json"
        req = urllib.request.Request(url, data=data, headers=headers, method=method)
        try:
            with urllib.request.urlopen(req, timeout=30) as resp:
                return json.loads(resp.read() or b"null")
        except urllib.error.HTTPError as err:
            if err.code == 403:
                sys.exit(
                    f"Sentry {method} {path}: 403 — the token needs {needed_permission(method, path)}. "
                    "Make a new token with that raised and log in again."
                )
            sys.exit(f"Sentry {method} {path}: {err.code} {err.read()[:300].decode(errors='replace')}")

    def issue_id(self, ref: str) -> str:
        """A numeric id, a short id (ODI-GC6) or an issue URL, as the numeric id."""
        ref = ref.strip()
        found = re.search(r"/issues/(\d+)", ref)
        if found:
            return found.group(1)
        if ref.isdigit():
            return ref
        hit = self.call("GET", f"/organizations/{self.org}/shortids/{urllib.parse.quote(ref.upper())}/")
        return str(hit.get("groupId") or hit.get("group", {}).get("id"))


def entry(event: dict, kind: str) -> dict:
    for item in event.get("entries") or []:
        if item.get("type") == kind:
            return item.get("data") or {}
    return {}


def frame_line(f: dict) -> str:
    name = re.sub(r"^(\.\./)+", "", f.get("filename") or f.get("absPath") or "?")
    where = f"{name}:{f.get('lineNo')}" if f.get("lineNo") else name
    tag = "" if f.get("inApp") else "  [library]"
    return f"  {where} in {f.get('function') or '?'}{tag}"


def print_stack(frames: list[dict], full: bool) -> None:
    last = len(frames) - 1
    folded = 0
    for i, f in enumerate(frames):
        if not (full or f.get("inApp") or i == last):
            folded += 1
            continue
        if folded:
            print(f"  … {folded} library frames …")
            folded = 0
        print(frame_line(f))
        for line, code in f.get("context") or []:
            if line == f.get("lineNo"):
                print(f"      {code.strip()}")


def print_event(event: dict, full: bool) -> None:
    print(f"event {event.get('eventID')} at {event.get('dateCreated')}")
    message = entry(event, "message").get("formatted") or event.get("message")
    if message:
        print(f"message: {message}")
    for exc in reversed(entry(event, "exception").get("values") or []):
        print(f"\n{exc.get('type')}: {exc.get('value')}")
        print_stack((exc.get("stacktrace") or {}).get("frames") or [], full)
    crumbs = entry(event, "breadcrumbs").get("values") or []
    if crumbs:
        shown = f"last 15 of {len(crumbs)}" if len(crumbs) > 15 else str(len(crumbs))
        print(f"\nbreadcrumbs ({shown}, oldest first):")
        for c in crumbs[-15:]:
            data = c.get("data") or {}
            said = c.get("message") or " ".join(str(data.get(k, "")) for k in ("method", "url", "status_code")).strip()
            print(f"  {str(c.get('timestamp'))[11:19]} {c.get('level')} {c.get('category')}  {said[:200]}")
    req = entry(event, "request")
    if req.get("url"):
        print(f"\nrequest: {req.get('method') or ''} {req.get('url')}")
    tags = event.get("tags") or []
    if tags:
        print("\ntags: " + ", ".join(f"{t.get('key')}={t.get('value')}" for t in tags))


def issue_row(i: dict) -> str:
    return (
        f"{i.get('shortId'):<10} {i.get('level'):<7} {str(i.get('count')):>6} ev {i.get('userCount'):>4} us  "
        f"{str(i.get('lastSeen'))[:16]}  {i.get('title')}  [{i.get('culprit')}]  id={i.get('id')}"
    )


def cmd_search(api: Api, a: argparse.Namespace) -> None:
    query = " ".join(a.query) if a.query else ""
    if "is:" not in query:
        query = f"is:unresolved {query}".strip()
    if a.project:
        query = f"project:{a.project} {query}"
    params = {"query": query, "sort": a.sort, "limit": str(a.limit), "statsPeriod": a.period}
    issues = api.call("GET", f"/organizations/{api.org}/issues/", params)
    if a.json:
        print(json.dumps(issues, indent=1))
        return
    for i in issues:
        print(issue_row(i))
    if not issues:
        print("no issues match")


def cmd_issue(api: Api, a: argparse.Namespace) -> None:
    iid = api.issue_id(a.issue)
    issue = api.call("GET", f"/organizations/{api.org}/issues/{iid}/")
    if a.json:
        print(json.dumps(issue, indent=1))
        return
    print(issue_row(issue))
    print(f"{issue.get('permalink')}\nstatus: {issue.get('status')} {issue.get('substatus') or ''}")
    print(f"first seen {issue.get('firstSeen')} · last seen {issue.get('lastSeen')}")
    for note in reversed([x for x in issue.get("activity") or [] if x.get("type") == "note"]):
        print(f"note by {(note.get('user') or {}).get('name')}: {(note.get('data') or {}).get('text')}")
    print()
    print_event(api.call("GET", f"/organizations/{api.org}/issues/{iid}/events/latest/"), full=False)


def cmd_event(api: Api, a: argparse.Namespace) -> None:
    iid = api.issue_id(a.issue)
    event = api.call("GET", f"/organizations/{api.org}/issues/{iid}/events/{a.event}/")
    if a.out:
        Path(a.out).write_text(json.dumps(event, indent=1))
        print(f"saved {a.out}")
    if a.json:
        print(json.dumps(event, indent=1))
    elif not a.out:
        print_event(event, full=a.full)


def cmd_events(api: Api, a: argparse.Namespace) -> None:
    iid = api.issue_id(a.issue)
    events = api.call("GET", f"/organizations/{api.org}/issues/{iid}/events/", {"per_page": str(a.limit)})
    for e in events[: a.limit]:
        tags = {t.get("key"): t.get("value") for t in e.get("tags") or []}
        user = (e.get("user") or {}).get("email") or (e.get("user") or {}).get("id") or ""
        print(f"{e.get('eventID')}  {str(e.get('dateCreated'))[:19]}  release={tags.get('release', '')[:12]}  {user}  {e.get('message') or e.get('title')}")


STATUS = {
    "resolve": {"status": "resolved"},
    "unresolve": {"status": "unresolved"},
    "ignore": {"status": "ignored", "statusDetails": {}, "substatus": "archived_until_escalating"},
}


def cmd_status(api: Api, a: argparse.Namespace) -> None:
    iid = api.issue_id(a.issue)
    api.call("PUT", f"/organizations/{api.org}/issues/{iid}/", body=STATUS[a.cmd])
    print(f"{a.cmd}d {a.issue}" if a.cmd != "ignore" else f"archived {a.issue} until it escalates")


def main() -> None:
    p = argparse.ArgumentParser(prog="sentry.py", description=__doc__)
    p.add_argument("--org")
    p.add_argument("--base-url", dest="base_url", help="the Sentry address (self-hosted)")
    sub = p.add_subparsers(dest="cmd", required=True)
    s = sub.add_parser("search", help="search issues (Sentry search syntax; is:unresolved unless an is: is given)")
    s.add_argument("query", nargs="*")
    s.add_argument("--project")
    s.add_argument("--sort", default="date", choices=["date", "new", "freq", "user"])
    s.add_argument("--limit", type=int, default=25)
    s.add_argument("--period", default="14d")
    s.add_argument("--json", action="store_true")
    i = sub.add_parser("issue", help="an issue and its latest event")
    i.add_argument("issue")
    i.add_argument("--json", action="store_true")
    e = sub.add_parser("event", help="one event of an issue: latest, oldest, recommended or an event id")
    e.add_argument("issue")
    e.add_argument("event", nargs="?", default="latest")
    e.add_argument("--full", action="store_true", help="every frame, not only in-app ones")
    e.add_argument("--json", action="store_true")
    e.add_argument("--out", help="save the whole event JSON to this file")
    ev = sub.add_parser("events", help="an issue's recent events")
    ev.add_argument("issue")
    ev.add_argument("--limit", type=int, default=20)
    for name in STATUS:
        w = sub.add_parser(name, help=f"{name} an issue (a write: only when the user asked for it)")
        w.add_argument("issue")
    a = p.parse_args()
    api = Api(*settings(a.org, a.base_url))
    handlers = {"search": cmd_search, "issue": cmd_issue, "event": cmd_event, "events": cmd_events}
    handlers.get(a.cmd, cmd_status)(api, a)


if __name__ == "__main__":
    main()
