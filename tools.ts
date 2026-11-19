/**
 * The Sentry tools every prifly session can call (`mcp__prifly__sentry_*`):
 * search issues, read an issue with its latest event, list an issue's events,
 * read one event. They are what the `sentry` skill's read commands do, served
 * by the extension itself, so a session never holds the reader's token: the
 * extension reads it (`auth.ts`'s `sentryToken`), makes the call and returns
 * text. Only reads — resolving and archiving stay on the issue chip.
 *
 * An error comes back as a thrown message (prifly returns it as the tool's
 * error); no message or result carries the token.
 */

import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { sentryToken } from "./auth";
import { eventDate, eventId, release } from "./event";
import { issueMarkdown } from "./issue-prompt";
import type { ExtensionTool, ExtensionToolContext } from "./prifly-api";
import { clip, obj, str } from "./read";
import { apiBase, ensureRegion } from "./region";
import {
  type Creds,
  type Issue,
  issueDetail,
  issueEvent,
  issueEvents,
  latestEvent,
  organizationIssues,
  readNotes,
  resolveIssueId,
  SentryError,
  type Sort,
} from "./sentry";
import type { World } from "./world";

const SORTS: readonly Sort[] = ["date", "new", "freq", "user"];

/** What a tool has once the login, organization and server are settled. */
type Connection = { creds: Creds; org: string };

const ORG_PROPERTY = {
  type: "string",
  description:
    "The Sentry organization's slug. Left out, the one chosen in the Sentry extension's settings.",
};

const ISSUE_PROPERTY = {
  type: "string",
  description: "An issue: a short id like PROJ-1A2, a numeric id, or an issue URL.",
};

export function sentryTools(world: () => World | null): ExtensionTool[] {
  /** Settles token, organization and server, runs `work`, and keeps the token out of whatever comes back. */
  async function run(
    args: Record<string, unknown>,
    work: (connection: Connection) => Promise<string>,
  ): Promise<string> {
    const at = world();
    if (at === null) throw new Error("The Sentry extension is not running.");
    const token = await sentryToken(at.api);
    if (token === null) {
      throw new Error(
        "Not logged in to Sentry. The reader logs in once from “From a Sentry issue…” in prifly; until then these tools have nothing to read with.",
      );
    }
    const org = text(args["org"]) || at.config.org;
    if (org === "") {
      throw new Error(
        "No Sentry organization: pass `org`, or choose one in “From a Sentry issue…” or the Sentry extension's settings.",
      );
    }
    try {
      await ensureRegion(at, org, token);
      const result = await work({ creds: { baseUrl: apiBase(at, org), token }, org });
      return result.replaceAll(token, "[token]");
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught);
      throw new Error(message.replaceAll(token, "[token]"));
    }
  }

  return [
    {
      name: "sentry_search",
      description:
        "Search Sentry issues (the reader's own login; read-only). Takes Sentry search syntax, like `level:fatal release:abc123`; `is:unresolved` is added unless the query has an `is:`. One line per issue: short id, level, event and user counts, last seen, title, culprit and numeric id.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "Sentry search syntax; may be empty." },
          project: { type: "string", description: "Only this project's slug." },
          sort: {
            type: "string",
            enum: [...SORTS],
            description: "date (default), new, freq or user.",
          },
          period: { type: "string", description: "How recently seen: 24h, 14d (default), 90d." },
          limit: {
            type: "number",
            description: "At most this many issues (default 25, up to 100).",
          },
          org: ORG_PROPERTY,
        },
      },
      call: (args) =>
        run(args, async ({ creds, org }) => {
          let query = text(args["query"]);
          if (!query.includes("is:")) query = `is:unresolved ${query}`.trim();
          const project = text(args["project"]);
          if (project !== "") query = `project:${project} ${query}`;
          const sort = SORTS.find((name) => name === args["sort"]) ?? "date";
          const issues = await organizationIssues(creds, org, {
            query,
            period: text(args["period"]) || "14d",
            sort,
            limit: limitOf(args["limit"], 25, 100),
          });
          return issues.length === 0 ? "no issues match" : issues.map(issueRow).join("\n");
        }),
    },
    {
      name: "sentry_issue",
      description:
        "One Sentry issue (read-only): status, counts, releases, notes, and its latest event summarised — the exception with in-app frames and the failing source line and locals, the last breadcrumbs, the request, context and tags. For the whole event as JSON use sentry_event with `save`.",
      inputSchema: {
        type: "object",
        properties: { issue: ISSUE_PROPERTY, org: ORG_PROPERTY },
        required: ["issue"],
      },
      call: (args) =>
        run(args, async ({ creds, org }) => {
          const id = await resolveIssueId(creds, org, required(args, "issue"));
          const { issue, raw } = await issueDetail(creds, org, id);
          const event = await latestEvent(creds, org, id).catch((caught: unknown) => {
            // An issue with no stored event (expired, or filtered) still has its facts.
            if (caught instanceof SentryError && caught.status === 404) return null;
            throw caught;
          });
          return issueText(issue, readNotes(raw), event);
        }),
    },
    {
      name: "sentry_events",
      description:
        "An issue's events, newest first (read-only), one line each: event id, time, release, user and message — to see whether an error is one user, one release or everywhere.",
      inputSchema: {
        type: "object",
        properties: {
          issue: ISSUE_PROPERTY,
          limit: {
            type: "number",
            description: "At most this many events (default 20, up to 100).",
          },
          org: ORG_PROPERTY,
        },
        required: ["issue"],
      },
      call: (args) =>
        run(args, async ({ creds, org }) => {
          const id = await resolveIssueId(creds, org, required(args, "issue"));
          const limit = limitOf(args["limit"], 20, 100);
          const events = (await issueEvents(creds, org, id, limit)).slice(0, limit);
          return events.length === 0 ? "no events" : events.map(eventRow).join("\n");
        }),
    },
    {
      name: "sentry_event",
      description:
        "One event of a Sentry issue (read-only): the latest (default), `oldest`, `recommended` or an event id, summarised like sentry_issue. With `save` the whole event JSON — every frame, local variable and breadcrumb — is written to your scratchpad and its path returned, for Read or jq.",
      inputSchema: {
        type: "object",
        properties: {
          issue: ISSUE_PROPERTY,
          event: {
            type: "string",
            description: "latest (default), oldest, recommended, or an event id.",
          },
          save: {
            type: "boolean",
            description:
              "Write the whole event JSON to the session's scratchpad and return the path.",
          },
          org: ORG_PROPERTY,
        },
        required: ["issue"],
      },
      call: (args, ctx) =>
        run(args, async ({ creds, org }) => {
          const ref = required(args, "issue");
          const id = await resolveIssueId(creds, org, ref);
          const [{ issue }, event] = await Promise.all([
            issueDetail(creds, org, id),
            issueEvent(creds, org, id, text(args["event"]) || "latest"),
          ]);
          const saved = args["save"] === true ? await saveEvent(ctx, issue, id, event) : "";
          return [saved, issueMarkdown(issue, event, Date.now())]
            .filter((part) => part !== "")
            .join("\n\n");
        }),
    },
  ];
}

/** The issue's facts and notes, then its latest event; the heading is the one the session prompt uses. */
function issueText(
  issue: Issue,
  notes: { by: string; at: string; text: string }[],
  event: unknown,
): string {
  const parts = [
    `# ${issue.title}`,
    `${issue.permalink} · ${issue.shortId} · project ${issue.project} · id ${issue.id}`,
    issueMarkdown(issue, event, Date.now()),
  ];
  if (event === null) parts.push("(Sentry has no stored event for this issue.)");
  if (notes.length > 0) {
    parts.push(
      `## Notes\n\n${notes.map((note) => `- ${note.by}${note.at === "" ? "" : ` (${note.at.slice(0, 16)})`}: ${clip(note.text, 600)}`).join("\n")}`,
    );
  }
  return parts.join("\n\n");
}

/** One issue in a line of a search. */
function issueRow(issue: Issue): string {
  return `${issue.shortId}  ${issue.level}  ${issue.count} ev  ${issue.userCount} us  ${issue.lastSeen.slice(0, 16)}  ${issue.title}  [${issue.culprit}]  id=${issue.id}`;
}

/** One event in a line of an event list. */
function eventRow(raw: unknown): string {
  const event = obj(raw);
  const who = obj(event["user"]);
  const person = str(who["email"]) || str(who["id"]);
  const said = str(event["message"]) || str(event["title"]);
  return `${eventId(event)}  ${eventDate(event).slice(0, 19)}  release=${clip(release(event), 12)}  ${person}  ${said}`;
}

/** Writes the whole event into the session's scratchpad; says where. */
async function saveEvent(
  ctx: ExtensionToolContext,
  issue: Issue,
  id: string,
  event: unknown,
): Promise<string> {
  let folder: string;
  try {
    folder = ctx.scratchpad;
  } catch (caught) {
    const why = caught instanceof Error ? caught.message : String(caught);
    throw new Error(`Cannot save: this session has no scratchpad folder (${why}).`);
  }
  const name = `sentry-${safeName(issue.shortId || id)}-${safeName(eventId(event) || "event")}.json`;
  const path = join(folder, name);
  await writeFile(path, `${JSON.stringify(event, null, 1)}\n`);
  return `Saved the whole event JSON to ${path}`;
}

function safeName(value: string): string {
  return value.replace(/[^A-Za-z0-9_.-]/g, "_");
}

/** A string argument, trimmed; "" when it is missing or not text. */
function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function required(args: Record<string, unknown>, name: string): string {
  const value = text(args[name]);
  if (value === "") throw new Error(`\`${name}\` is required.`);
  return value;
}

function limitOf(value: unknown, fallback: number, most: number): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.min(most, Math.max(1, Math.floor(value)))
    : fallback;
}
