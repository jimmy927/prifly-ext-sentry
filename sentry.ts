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

/**
 * Which of Sentry's token permissions a call needs, in the words the "Create
 * New Token" page uses — for a 403's message. Order matters: the exact
 * organization and project-list paths are checked before the method falls
 * back to "an issue or event".
 */
function neededPermission(method: string, path: string): string {
  if (path === "/auth/" || path === "/organizations/") return "Organization: Read";
  if (/^\/organizations\/[^/]+\/code-mappings\/$/.test(path)) return "Organization: Read";
  if (/^\/organizations\/[^/]+\/projects\/$/.test(path)) return "Project: Read";
  if (method === "PUT") return "Issue & Event: Read & Write";
  return "Issue & Event: Read";
}

export class SentryError extends Error {
  readonly status: number;
  constructor(method: string, path: string, status: number, detail: string) {
    super(SentryError.describe(method, path, status, detail));
    this.status = status;
  }

  private static describe(method: string, path: string, status: number, detail: string): string {
    if (status === 401) {
      return "Sentry refused the token (401). Log in again from “From a Sentry issue…”.";
    }
    if (status === 403) {
      return `Sentry refused this (403) — the token needs ${neededPermission(method, path)}. Make a new token with that raised and log in again.`;
    }
    return `Sentry ${path}: ${status}${detail === "" ? "" : ` ${detail}`}`;
  }
}

async function call(
  creds: Creds,
  method: "GET" | "PUT",
  path: string,
  // Pairs when a name repeats: `groups=1&groups=2`.
  params: Record<string, string> | [string, string][] = {},
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
    throw new SentryError(method, path, response.status, detail);
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

/**
 * An organization, and the data region that hosts it: `links.regionUrl` in
 * Sentry's `/organizations/` answer (`https://de.sentry.io` for an EU
 * organization, `https://us.sentry.io` for a US one). "" when Sentry gives
 * none, as a self-hosted Sentry does not.
 */
export type Org = Named & { regionUrl: string };

export async function organizations(creds: Creds): Promise<Org[]> {
  const orgs = arr(await call(creds, "GET", "/organizations/", { member: "1" }));
  return orgs.map(obj).map((org) => ({
    slug: str(org["slug"]),
    name: str(org["name"]),
    regionUrl: str(obj(org["links"])["regionUrl"]).replace(/\/+$/, ""),
  }));
}

export async function projects(creds: Creds, org: string): Promise<Named[]> {
  const found = arr(await call(creds, "GET", `/organizations/${enc(org)}/projects/`));
  return found.map(obj).map((project) => ({
    slug: str(project["slug"]),
    name: str(project["name"]) || str(project["slug"]),
  }));
}

/**
 * Which repository a project's stack frames come from, as the organization's
 * source-code integration has it: `repo` is the provider's `owner/name`.
 * Sentry makes some by itself (`automatic`) from paths it saw in frames —
 * often vendored or long-gone repos — besides the ones a person set up.
 */
export type CodeMapping = {
  project: string;
  repo: string;
  branch: string;
  stackRoot: string;
  automatic: boolean;
};

/** Every code mapping in the organization, for all its projects at once. */
export async function codeMappings(creds: Creds, org: string): Promise<CodeMapping[]> {
  const found = arr(await call(creds, "GET", `/organizations/${enc(org)}/code-mappings/`));
  return found.map(obj).map((mapping) => ({
    project: str(mapping["projectSlug"]),
    repo: str(mapping["repoName"]),
    branch: str(mapping["defaultBranch"]),
    stackRoot: str(mapping["stackRoot"]),
    automatic: mapping["automaticallyGenerated"] === true,
  }));
}

export type IssueQuery = { query: string; period: string; sort: Sort; limit: number };

/**
 * The organization's issues, every project the token can see at once
 * (`project=-1`), as the configured query and sort have them — so a project
 * made in Sentry tomorrow is listed without anything set up here.
 */
export async function organizationIssues(
  creds: Creds,
  org: string,
  ask: IssueQuery,
): Promise<Issue[]> {
  const found = arr(
    await call(creds, "GET", `/organizations/${enc(org)}/issues/`, {
      project: "-1",
      query: ask.query,
      statsPeriod: ask.period,
      sort: ask.sort,
      limit: String(ask.limit),
    }),
  );
  return found.map(readIssue);
}

/**
 * Events per bucket over `period`, oldest first, for each of these issues.
 *
 * The project issue list gives bars only for `24h` and `14d`; this endpoint
 * takes any period, and `groupStatsPeriod=auto` cuts it into about thirty
 * buckets — two minutes each over an hour, an hour over a day, six hours over
 * a week (measured against sentry.io, 2026-09-29).
 */
export async function issueStats(
  creds: Creds,
  org: string,
  ids: string[],
  period: string,
): Promise<Map<string, number[]>> {
  const params: [string, string][] = ids.map((id) => ["groups", id]);
  params.push(["groupStatsPeriod", "auto"], ["statsPeriod", period]);
  const found = arr(await call(creds, "GET", `/organizations/${enc(org)}/issues-stats/`, params));
  const counts = new Map<string, number[]>();
  for (const entry of found.map(obj)) {
    const buckets = arr(obj(entry["stats"])["auto"]);
    counts.set(
      str(entry["id"]),
      buckets.map((bucket) => {
        const count = arr(bucket)[1];
        return typeof count === "number" ? count : 0;
      }),
    );
  }
  return counts;
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
 * this extension makes, and only from a menu the reader chose. Archiving also
 * takes the issue off the reader's bookmarks, Sentry's favourites.
 */
export async function setStatus(
  creds: Creds,
  org: string,
  id: string,
  status: StatusChange,
): Promise<void> {
  const body: Json =
    status === "ignored"
      ? { status, statusDetails: {}, substatus: "archived_until_escalating", isBookmarked: false }
      : { status };
  await call(creds, "PUT", `/organizations/${enc(org)}/issues/${enc(id)}/`, {}, body);
}
