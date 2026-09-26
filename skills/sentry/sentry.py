#!/usr/bin/env python3
"""
Sentry CLI for Claude Code sessions: search issues, read an issue and an
event, list an issue's events, and resolve / archive / reopen an issue.

Credentials, in order: SENTRY_AUTH_TOKEN; the prifly Sentry extension's
auth.json (the token the reader pasted into prifly's "From a Sentry issue…");
~/.sentryclirc's [auth] token (what `sentry-cli login` writes). The
organization: --org, SENTRY_ORG, the extension's config.json, then
~/.sentryclirc's [defaults] org. Standard library only.
"""

from __future__ import annotations

import argparse
import configparser
import json
import os
import re
import sys
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any

HOME = Path.home()


def extension_roots() -> list[Path]:
    """This file's own extension first, then the one prifly runs (a plugin copy has no auth.json)."""
    here = Path(__file__).resolve().parent.parent.parent
    named = os.environ.get("PRIFLY_SENTRY_HOME")
    installed = HOME / ".local/share/prifly/extensions/prifly-ext-sentry"
    roots = ([Path(named)] if named else []) + [here, installed]
    return list(dict.fromkeys(roots))


def read_json(name: str, field: str) -> str:
    for root in extension_roots():
        try:
            found = json.loads((root / name).read_text()).get(field)
        except (OSError, ValueError):
            continue
        if found:
            return str(found)
    return ""


def clirc(section: str, key: str) -> str:
    parser = configparser.ConfigParser()
    try:
        parser.read(HOME / ".sentryclirc")
        return parser.get(section, key, fallback="").strip().strip("\"'")
    except configparser.Error:
        return ""


def settings(org_flag: str | None) -> tuple[str, str, str]:
    """The API root, the token and the organization."""
    token = os.environ.get("SENTRY_AUTH_TOKEN") or read_json("auth.json", "token") or clirc("auth", "token")
    if not token:
        sys.exit(
            "not logged in to Sentry: open prifly, click 'From a Sentry issue…' and log in "
            "(or set SENTRY_AUTH_TOKEN, or run `sentry-cli login`)"
        )
    base = os.environ.get("SENTRY_URL") or read_json("config.json", "baseUrl") or clirc("defaults", "url")
    org = org_flag or os.environ.get("SENTRY_ORG") or read_json("config.json", "org") or clirc("defaults", "org")
    if not org:
        sys.exit("no Sentry organization: pass --org, or choose one in prifly's 'From a Sentry issue…'")
    return (base or "https://sentry.io").rstrip("/") + "/api/0", token, org


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
    api = Api(*settings(a.org))
    handlers = {"search": cmd_search, "issue": cmd_issue, "event": cmd_event, "events": cmd_events}
    handlers.get(a.cmd, cmd_status)(api, a)


if __name__ == "__main__":
    main()
