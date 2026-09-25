/**
 * Sentry, as much of it as this extension needs: who the token is, the
 * reader's organizations and projects, a project's issues, one issue with its
 * latest event, and an issue's status changed.
 *
 * Every call carries the reader's own token (`auth.ts`) as a bearer header, so
 * each reader sees what their Sentry account sees and nothing else. Writes are
 * one kind only — an issue's status, from a chip's menu the reader chose.
 */

import { arr, type Json, num, obj, str } from "./read";

export type Creds = { baseUrl: string; token: string };

/** An issue, as the chooser, the chip and the prompt read it. */
export type Issue = {
  id: string;
  shortId: string;
  title: string;
  culprit: string;
  permalink: string;
  level: string;
  /** unresolved, resolved, ignored. */
  status: string;
  /** new, ongoing, escalating, regressed, archived_until_escalating…; "" when none. */
  substatus: string;
  platform: string;
  project: string;
  count: number;
  userCount: number;
  firstSeen: string;
  lastSeen: string;
  numComments: number;
  /** Who it is assigned to, by name; "" for nobody. */
  assignee: string;
  isUnhandled: boolean;
  /** Only the issue's own endpoint has these; the list leaves them "". */
  firstRelease: string;
  lastRelease: string;
};

export type Sort = "date" | "new" | "freq" | "user";

/** One raw issue, from the list or the issue's own endpoint. */
export function readIssue(raw: unknown): Issue {
  const issue = obj(raw);
  const project = obj(issue["project"]);
  return {
    id: str(issue["id"]),
    shortId: str(issue["shortId"]),
    title: str(issue["title"]) || str(obj(issue["metadata"])["title"]) || "(untitled issue)",
    culprit: str(issue["culprit"]),
    permalink: str(issue["permalink"]),
    level: str(issue["level"]) || "error",
    status: str(issue["status"]) || "unresolved",
    substatus: str(issue["substatus"]),
    platform: str(issue["platform"]),
    project: str(project["slug"]),
    count: num(issue["count"]),
    userCount: num(issue["userCount"]),
    firstSeen: str(issue["firstSeen"]),
    lastSeen: str(issue["lastSeen"]),
    numComments: num(issue["numComments"]),
    assignee: str(obj(issue["assignedTo"])["name"]),
    isUnhandled: issue["isUnhandled"] === true,
    firstRelease: releaseName(issue["firstRelease"]),
    lastRelease: releaseName(issue["lastRelease"]),
  };
}

/** A release object's short version, or "" for none. */
export function releaseName(raw: unknown): string {
  const release = obj(raw);
  return shortRelease(str(release["shortVersion"]) || str(release["version"]));
}

/** A release named by a whole commit SHA reads as its first twelve characters, as git shows it. */
export function shortRelease(version: string): string {
  return /^[0-9a-f]{40}$/i.test(version) ? version.slice(0, 12) : version;
}

/** Notes people left on the issue, oldest first, from its activity. */
export function readNotes(raw: unknown): { by: string; at: string; text: string }[] {
  return arr(obj(raw)["activity"])
    .map(obj)
    .filter((entry) => entry["type"] === "note")
    .map((entry) => ({
      by: str(obj(entry["user"])["name"]) || "someone",
      at: str(entry["dateCreated"]),
      text: str(obj(entry["data"])["text"]),
    }))
    .reverse();
}

export class SentryError extends Error {
  readonly status: number;
  constructor(path: string, status: number, detail: string) {
    super(
      status === 401
        ? "Sentry refused the token (401). Log in again from “From a Sentry issue…”."
        : `Sentry ${path}: ${status}${detail === "" ? "" : ` ${detail}`}`,
    );
    this.status = status;
  }
}

async function call(
  creds: Creds,
  method: "GET" | "PUT",
  path: string,
  params: Record<string, string> = {},
  body?: Json,
): Promise<unknown> {
  const query = new URLSearchParams(params).toString();
  const url = `${creds.baseUrl.replace(/\/+$/, "")}/api/0${path}${query === "" ? "" : `?${query}`}`;
  const headers: Record<string, string> = { Authorization: `Bearer ${creds.token}` };
  const init: RequestInit = { method, headers, signal: AbortSignal.timeout(30_000) };
  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  const response = await fetch(url, init);
  if (!response.ok) {
    const detail = str(obj(await response.json().catch(() => null))["detail"]);
    throw new SentryError(path, response.status, detail);
  }
  return await response.json();
}

const enc = encodeURIComponent;

/** Who the token belongs to — and proof that it works at all. */
export async function whoami(creds: Creds): Promise<string> {
  const user = obj(await call(creds, "GET", "/auth/"));
  return str(user["name"]) || str(user["email"]) || str(user["username"]) || "you";
}

export type Named = { slug: string; name: string };

export async function organizations(creds: Creds): Promise<Named[]> {
  const orgs = arr(await call(creds, "GET", "/organizations/", { member: "1" }));
  return orgs.map(obj).map((org) => ({ slug: str(org["slug"]), name: str(org["name"]) }));
}

export async function projects(creds: Creds, org: string): Promise<Named[]> {
  const found = arr(await call(creds, "GET", `/organizations/${enc(org)}/projects/`));
  return found.map(obj).map((project) => ({
    slug: str(project["slug"]),
    name: str(project["name"]) || str(project["slug"]),
  }));
}

export type IssueQuery = { query: string; period: string; sort: Sort; limit: number };

/** One project's issues, as the configured query and sort have them. */
export async function projectIssues(
  creds: Creds,
  org: string,
  project: string,
  ask: IssueQuery,
): Promise<Issue[]> {
  const found = arr(
    await call(creds, "GET", `/projects/${enc(org)}/${enc(project)}/issues/`, {
      query: ask.query,
      statsPeriod: ask.period,
      sort: ask.sort,
      limit: String(ask.limit),
    }),
  );
  return found.map(readIssue).map((issue) => ({ ...issue, project: issue.project || project }));
}

/** One issue, read from its own endpoint: releases and activity included. */
export async function issueDetail(
  creds: Creds,
  org: string,
  id: string,
): Promise<{ issue: Issue; raw: unknown }> {
  const raw = await call(creds, "GET", `/organizations/${enc(org)}/issues/${enc(id)}/`);
  return { issue: readIssue(raw), raw };
}

/** The issue's most recent event, whole, exactly as Sentry returns it. */
export function latestEvent(creds: Creds, org: string, id: string): Promise<unknown> {
  return call(creds, "GET", `/organizations/${enc(org)}/issues/${enc(id)}/events/latest/`);
}

export type StatusChange = "resolved" | "unresolved" | "ignored";

/**
 * An issue resolved, reopened, or archived until it escalates — the one write
 * this extension makes, and only from a menu the reader chose.
 */
export async function setStatus(
  creds: Creds,
  org: string,
  id: string,
  status: StatusChange,
): Promise<void> {
  const body: Json =
    status === "ignored"
      ? { status, statusDetails: {}, substatus: "archived_until_escalating" }
      : { status };
  await call(creds, "PUT", `/organizations/${enc(org)}/issues/${enc(id)}/`, {}, body);
}
