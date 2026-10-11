/**
 * A Sentry issue, as the first thing a session is told.
 *
 * What a person opens Sentry for, in the order they look: what broke and how
 * often, since when and in which release, the stack trace with the reader's
 * own frames in front, what happened just before (breadcrumbs), and the
 * request and environment it happened in. The whole latest event is saved
 * beside it, so the trimmed trace is a starting point and not the limit.
 */

import {
  breadcrumbs,
  type Crumb,
  contexts,
  eventDate,
  eventId,
  evidence,
  exceptions,
  message,
  release,
  request,
  tags,
  user,
} from "./event";
import { brief, clip, str } from "./read";
import type { Issue } from "./sentry";
import { renderChain } from "./stack";
import { ago, when } from "./time";

export type PromptParts = {
  issue: Issue;
  /** The latest event, raw, as Sentry returned it; null when it could not be read. */
  event: unknown;
  /** Where the event was saved, and what landed there. */
  folder: string;
  files: string[];
  now: number;
  /** The organization and Sentry address this extension is set to, for the sentry skill's flags. */
  org?: string;
  baseUrl?: string;
};

/** The issue read whole, as Markdown: the chooser's reading pane and the prompt share it. */
export function issueMarkdown(issue: Issue, event: unknown, now: number): string {
  return [
    facts(issue, event, now),
    section("Evidence", listed(evidence(event))),
    section("Message", extraMessage(issue, event)),
    section("Exception", renderChain(exceptions(event))),
    crumbSection(breadcrumbs(event)),
    section("Request", requestBlock(event)),
    section("Context", listed([...contexts(event), ["user", user(event)]])),
    section("Tags", listed(tags(event).filter(([key]) => !SAID_ELSEWHERE.has(key)))),
  ]
    .filter((block) => block !== "")
    .join("\n\n");
}

/** Tags the facts or the Context section already state. */
const SAID_ELSEWHERE = new Set([
  "level",
  "handled",
  "mechanism",
  "release",
  "interface_type",
  "browser",
  "browser.name",
  "os",
  "os.name",
  "client_os",
  "client_os.name",
  "runtime",
  "runtime.name",
  "device",
  "device.family",
  "user",
]);

export function issuePrompt(parts: PromptParts): string {
  const { issue } = parts;
  return [
    `# ${issue.title}`,
    `${issue.permalink} · ${issue.shortId} · project ${issue.project}`,
    issueMarkdown(issue, parts.event, parts.now),
    section("Saved on disk", savedFiles(parts)),
    skillFlags(parts),
    instruction(),
  ]
    .filter((block) => block !== "")
    .join("\n\n");
}

/** What the sentry skill needs to reach the same organization and server as this extension. */
function skillFlags(parts: PromptParts): string {
  const flags = [
    parts.org === undefined || parts.org === "" ? "" : `--org ${shellWord(parts.org)}`,
    parts.baseUrl === undefined || parts.baseUrl === ""
      ? ""
      : `--base-url ${shellWord(parts.baseUrl)}`,
  ].filter((flag) => flag !== "");
  return flags.length === 0
    ? ""
    : `When you use the sentry skill's script for this issue, pass \`${flags.join(" ")}\` before the subcommand.`;
}

/** A value as one shell word: plain ones as they are, anything else in single quotes. */
function shellWord(value: string): string {
  return /^[\w.:/@-]+$/.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`;
}

function section(heading: string, body: string): string {
  return body.trim() === "" ? "" : `## ${heading}\n\n${body}`;
}

function listed(rows: readonly [string, string][]): string {
  return rows
    .filter(([, value]) => value !== "")
    .map(([key, value]) => `- ${key}: ${clip(value, 300)}`)
    .join("\n");
}

function seen(iso: string, now: number): string {
  const exact = when(iso);
  return exact === "" ? "?" : `${exact} (${ago(iso, now)} ago)`;
}

function facts(issue: Issue, event: unknown, now: number): string {
  const status = issue.substatus === "" ? issue.status : `${issue.status} (${issue.substatus})`;
  const releases = [
    issue.firstRelease === "" ? "" : `first ${issue.firstRelease}`,
    issue.lastRelease === "" ? "" : `last ${issue.lastRelease}`,
    release(event) === "" ? "" : `this event ${release(event)}`,
  ].filter((part) => part !== "");
  const latest = eventId(event);
  const rows: [string, string][] = [
    [
      "Level",
      `${issue.level} · ${status}${issue.isUnhandled ? " · unhandled" : ""} · ${issue.platform}`,
    ],
    ["Culprit", issue.culprit === "" ? "" : `\`${issue.culprit}\``],
    ["Events", `${issue.count} · users affected: ${issue.userCount}`],
    ["First seen", seen(issue.firstSeen, now)],
    ["Last seen", seen(issue.lastSeen, now)],
    ["Releases", releases.join(" · ")],
    ["Assigned to", issue.assignee],
    ["Latest event", latest === "" ? "" : `${latest} at ${when(eventDate(event))}`],
  ];
  return listed(rows);
}

/** A logged message that says more than the title does. */
function extraMessage(issue: Issue, event: unknown): string {
  const said = message(event).trim();
  if (said === "" || said === issue.title || issue.title.startsWith(said)) return "";
  return clip(said, 2000);
}

const MOST_CRUMBS = 15;

function crumbSection(crumbs: readonly Crumb[]): string {
  if (crumbs.length === 0) return "";
  const shown = crumbs.slice(-MOST_CRUMBS);
  const heading =
    crumbs.length > shown.length
      ? `## Breadcrumbs (last ${shown.length} of ${crumbs.length}, oldest first)`
      : "## Breadcrumbs (oldest first)";
  return `${heading}\n\n\`\`\`text\n${shown.map(crumbLine).join("\n")}\n\`\`\``;
}

/** One breadcrumb in a line: `07:57:11 error fetch  GET /api/x → 502`. */
export function crumbLine(crumb: Crumb): string {
  const time = crumb.timestamp.slice(11, 19);
  const what = crumb.category || crumb.type;
  const said = crumb.message || httpSummary(crumb) || dataSummary(crumb);
  return `${time} ${crumb.level || "info"} ${what}  ${clip(said.replaceAll("\n", " "), 240)}`.trimEnd();
}

/** An HTTP breadcrumb's method, URL and status: `GET /api/x → 502`. */
function httpSummary(crumb: Crumb): string {
  const { data } = crumb;
  if (crumb.type !== "http" && typeof data["url"] !== "string") return "";
  const status = data["status_code"];
  return [
    str(data["method"]),
    str(data["url"]),
    status === undefined || status === null ? "" : `→ ${str(status)}`,
  ]
    .filter((part) => part !== "")
    .join(" ");
}

function dataSummary(crumb: Crumb): string {
  return Object.keys(crumb.data).length === 0 ? "" : brief(crumb.data, 200);
}

const HEADERS = new Set(["user-agent", "referer", "content-type"]);

function requestBlock(event: unknown): string {
  const found = request(event);
  if (found === null) return "";
  const query = found.query.map(([key, value]) => `${key}=${value}`).join("&");
  const headers = found.headers
    .filter(([name]) => HEADERS.has(name.toLowerCase()))
    .map(([name, value]) => `${name}: ${value}`);
  const body =
    found.data === null ||
    found.data === "" ||
    (typeof found.data === "object" && Object.keys(found.data).length === 0)
      ? ""
      : brief(found.data, 800);
  return [
    `${found.method === "" ? "" : `${found.method} `}${found.url}`,
    query === "" ? "" : `query: ${clip(query, 400)}`,
    ...headers.map((line) => clip(line, 300)),
    body === "" ? "" : `body: ${body}`,
  ]
    .filter((line) => line !== "")
    .map((line) => `- ${line}`)
    .join("\n");
}

function savedFiles(parts: PromptParts): string {
  if (parts.files.length === 0) return "";
  return `In ${parts.folder}:\n${parts.files.map((file) => `- ${file}`).join("\n")}\n\nThe event file is the whole latest event as Sentry returns it: every frame with its source and local variables, every breadcrumb, all contexts. Read it with the Read tool (or \`jq\`) when the trimmed trace above is not enough.`;
}

/**
 * What to do first. Finding the cause in this checkout comes before a fix,
 * and the issue's status is left to the reader — its chip resolves it.
 */
function instruction(): string {
  return "---\n\nThis session is for that Sentry issue. Find where it comes from in this checkout before changing anything, and say briefly what you take the cause to be and what you plan to do; then do it. Do not resolve or ignore the issue in Sentry unless you are asked to.";
}
