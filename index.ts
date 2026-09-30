/**
 * Your Sentry issues, in prifly.
 *
 * "From a Sentry issue…", beside New session, lays out the unresolved issues
 * of every project in your organization — new, escalating, regressed,
 * ongoing — newest or busiest first. The one you pick becomes a session in
 * that project's checkout, found through Sentry's code mappings
 * (`checkout.ts`), that starts knowing the issue: counts, releases, tags, the latest
 * event's stack trace with your own frames in front, breadcrumbs, request —
 * and the whole latest event saved as JSON beside the prompt. The issue then
 * stays on that session's banner: click it to open it in Sentry, or use its
 * menu to resolve or archive it when the work is done.
 *
 * There is nothing to configure by hand. The first time you open the chooser
 * it offers the login, then your organizations. See `setup.ts` for that,
 * `auth.ts` for where the token comes
 * from, and `world.ts` for the small files this folder keeps.
 */

import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { mainCheckout } from "./checkout";
import { eventId } from "./event";
import { COLUMNS, issueChip, issueFace, issueItem, launcherFlag } from "./issue-face";
import { issuePrompt } from "./issue-prompt";
import type {
  Decoration,
  ExtensionApi,
  Launch,
  LaunchBoard,
  LaunchChoice,
  LaunchItem,
} from "./prifly-api";
import { clip } from "./read";
import {
  type Creds,
  type Issue,
  issueDetail,
  latestEvent,
  readNotes,
  SentryError,
  type StatusChange,
  setStatus,
} from "./sentry";
import { isSetupKey, runSetup, setupChoices, setupTail } from "./setup";
import { shortDate } from "./time";
import { checkoutOf, creds, load, ready, reload, type World, writeState } from "./world";

let world: World | null = null;

export async function activate(api: ExtensionApi): Promise<() => void> {
  world = await load(api);
  let stopped = false;
  const tick = async () => {
    try {
      // Nothing is asked of Sentry until the reader has logged in and chosen
      // an organization: an extension that is only enabled should sit quiet.
      if (ready(here())) {
        await reload(here());
        show();
      }
    } catch (caught) {
      // Sentry down, a revoked token, no network: said in the log and tried
      // again on the next tick, with what was last seen still on screen.
      api.log("refresh_failed", { message: message(caught) });
    }
  };
  await tick();
  const timer = setInterval(() => {
    if (!stopped) void tick();
  }, world.config.refreshSeconds * 1000);
  return () => {
    stopped = true;
    clearInterval(timer);
    world = null;
  };
}

/** The chips: one issue on the session that was started from it. */
function show(): void {
  const at = here();
  const bySession: Record<string, Decoration[]> = {};
  const known = new Set(at.api.sessions().map((session) => session.id));
  const now = Date.now();
  for (const [sessionId, issueId] of Object.entries(at.state.links)) {
    const issue = at.linked.get(issueId);
    // A deleted issue stops being drawn; the link stays in case it was a blip.
    if (issue === undefined || !known.has(sessionId)) continue;
    bySession[sessionId] = [issueChip(issue, now)];
  }
  at.api.show(bySession, []);
  at.api.flag?.("issue", launcherFlag(at.issues));
}

/**
 * What the chooser shows: the setup steps until there are none, then the
 * issues in Sentry's triage columns, filtered by what the reader typed, with
 * the rows for changing the setup kept beside them.
 */
export async function choices(
  _launchId: string,
  query: string,
): Promise<LaunchChoice[] | LaunchBoard> {
  const at = here();
  const setup = await setupChoices(at);
  if (setup !== null) return setup;
  if (at.loadedAt === 0) await reload(at);
  const words = query.trim().toLowerCase();
  const projects = [...new Set(at.issues.map((issue) => issue.project))];
  const notes = new Map(projects.map((project) => [project, folderNote(at, project)]));
  const several = projects.length > 1;
  const now = Date.now();
  return {
    columns: COLUMNS,
    items: at.issues
      .filter((issue) => matches(issue, words))
      .map((issue) =>
        issueFace(issue, several, now, at.sparks.get(issue.id), notes.get(issue.project)),
      ),
    actions: setupTail(at),
  };
}

/** Why a project's session will ask for its folder, or "" when the folder is found. */
export function folderNote(at: World, project: string): string {
  const { repo, folder } = checkoutOf(at, project);
  if (folder !== "") return "";
  return repo === ""
    ? `no code mapping in Sentry for ${project}: you pick the folder`
    : `${repo} is not checked out in ~, ~/src or ~/code: you pick the folder`;
}

/** Title, culprit, short id, level, project and assignee: what a person would search by. */
export function matches(issue: Issue, words: string): boolean {
  if (words === "") return true;
  const haystack = [
    issue.title,
    issue.culprit,
    issue.shortId,
    issue.level,
    issue.project,
    issue.assignee,
  ]
    .join(" ")
    .toLowerCase();
  return words.split(/\s+/).every((word) => haystack.includes(word));
}

function needCreds(at: World): Creds {
  const auth = creds(at);
  if (auth === null) throw new Error("Not logged in to Sentry.");
  return auth;
}

/** One issue, read whole over the board. */
export async function open(_launchId: string, key: string): Promise<LaunchItem> {
  const at = here();
  const auth = needCreds(at);
  const [detail, event] = await Promise.all([
    issueDetail(auth, at.config.org, key),
    latestEvent(auth, at.config.org, key).catch(noEvent),
  ]);
  const notes = readNotes(detail.raw).map((note) => ({ ...note, at: shortDate(note.at) }));
  return issueItem(detail.issue, event, notes, Date.now());
}

/** An issue whose events have all aged out has none to read: said, not thrown. */
function noEvent(caught: unknown): null {
  if (caught instanceof SentryError && caught.status === 404) return null;
  throw caught;
}

/** The issue as a session's first prompt, its latest event on disk — or a setup step taken. */
export async function launch(_launchId: string, key: string, input: string): Promise<Launch> {
  const at = here();
  if (isSetupKey(key)) {
    const done = await runSetup(at, key, input);
    if (done !== null) {
      if (ready(at)) {
        await reload(at);
        show();
      } else {
        at.api.show({}, []);
        at.api.flag?.("issue", null);
      }
      return done;
    }
  }
  return await issueLaunch(at, key);
}

/**
 * An issue, as a session starts from it: the prompt carries the trimmed
 * story, and the folder beside it carries the issue and its latest event
 * whole, for everything the trimming left out.
 */
async function issueLaunch(at: World, key: string): Promise<Launch> {
  const auth = needCreds(at);
  const [detail, event] = await Promise.all([
    issueDetail(auth, at.config.org, key),
    latestEvent(auth, at.config.org, key).catch(noEvent),
  ]);
  const { issue } = detail;
  const folder = join(at.api.folder, "issues", safeName(issue.shortId || issue.id));
  await mkdir(folder, { recursive: true });
  const issueFile = join(folder, "issue.json");
  await Bun.write(issueFile, JSON.stringify(detail.raw, null, 2));
  const files = [issueFile];
  if (event !== null) {
    const saved = join(folder, `event-${safeName(eventId(event)) || "latest"}.json`);
    await Bun.write(saved, JSON.stringify(event, null, 2));
    files.push(saved);
  }
  const checkout = checkoutOf(at, issue.project);
  at.api.log("launch", {
    issue: issue.shortId,
    project: issue.project,
    event: event !== null,
    repo: checkout.repo,
    cwd: checkout.folder,
  });
  const seeded: Launch = {
    prompt: issuePrompt({ issue, event, folder, files, now: Date.now() }),
    name: clip(issue.title, 60),
  };
  // Found nowhere, the New session form asks, and `launched` remembers the answer.
  if (checkout.folder !== "") seeded.cwd = checkout.folder;
  else seeded.message = `${issue.shortId}: ${folderNote(at, issue.project)}.`;
  return seeded;
}

/** A file name that is only a file name: no folders, no surprises. */
export function safeName(name: string): string {
  return name
    .replaceAll(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^[-.]+/, "")
    .slice(0, 80);
}

/**
 * The session that issue became: remembered, so the chip finds its row
 * again — and the checkout it runs in remembered for the issue's project, so
 * a folder the reader picked in the New session form is the next one's too.
 */
export async function launched(_launchId: string, key: string, sessionId: string): Promise<void> {
  const at = here();
  at.state.links[sessionId] = key;
  const issue = at.issues.find((entry) => entry.id === key) ?? at.linked.get(key);
  const cwd = at.api.sessions().find((session) => session.id === sessionId)?.cwd ?? "";
  const top = cwd === "" ? "" : mainCheckout(cwd);
  if (issue !== undefined && top !== "") at.state.folders[issue.project] = top;
  await writeState(at.api.folder, at.state);
  if (issue !== undefined) at.linked.set(key, issue);
  show();
}

const CHANGES: Record<string, { status: StatusChange; said: string }> = {
  resolve: { status: "resolved", said: "Resolved" },
  ignore: { status: "ignored", said: "Archived until it escalates:" },
  unresolve: { status: "unresolved", said: "Reopened" },
};

/**
 * What an issue's menu offers, from its chip or its card: its status in
 * Sentry changed, then everything read again so both say so.
 */
export async function action(key: string, actionId: string): Promise<string> {
  const at = here();
  const auth = needCreds(at);
  const change = CHANGES[actionId];
  if (change === undefined) throw new Error(`Nothing to do for ${actionId}`);
  const issue = at.linked.get(key) ?? at.issues.find((entry) => entry.id === key);
  await setStatus(auth, at.config.org, key, change.status);
  at.api.log("status", { issue: key, status: change.status });
  await reload(at);
  show();
  return `${change.said} ${issue?.shortId ?? key}${issue === undefined ? "" : ` “${clip(issue.title, 60)}”`}.`;
}

function here(): World {
  if (world === null) throw new Error("The Sentry extension is not running");
  return world;
}

function message(caught: unknown): string {
  return caught instanceof Error ? caught.message : String(caught);
}
