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
import { LINK_ACTION, withLink } from "./link-actions";
import type {
  ActionPicked,
  Decoration,
  DecorationAction,
  ExtensionApi,
  ExtensionSession,
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
import {
  checkoutOf,
  creds,
  linkIssue,
  load,
  ready,
  reload,
  unlinkIssue,
  type World,
  writeState,
} from "./world";

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

/** The chips: one per issue the session was started from or linked to. */
function show(): void {
  const at = here();
  const bySession: Record<string, Decoration[]> = {};
  const known = new Set(at.api.sessions().map((session) => session.id));
  const now = Date.now();
  for (const [sessionId, issueIds] of Object.entries(at.state.links)) {
    if (!known.has(sessionId)) continue;
    const chips = issueIds.flatMap((issueId) => {
      const issue = at.linked.get(issueId);
      // A deleted issue stops being drawn; the link stays in case it was a blip.
      if (issue === undefined) return [];
      const chip = issueChip(issue, now);
      return [{ ...chip, actions: [...(chip.actions ?? []), unlinkAction(sessionId)] }];
    });
    if (chips.length > 0) bySession[sessionId] = chips;
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
        linkable(
          alreadyStarted(
            issueFace(issue, several, now, at.sparks.get(issue.id), notes.get(issue.project)),
            issue.shortId,
            sessionsOf(at, issue.id),
          ),
        ),
      ),
    actions: setupTail(at),
  };
}

/**
 * An issue that already has a session can be linked to it: "Link to
 * session…", just before the destructive "Archive until it escalates", opens
 * prifly's session picker.
 */
function linkable(face: LaunchChoice): LaunchChoice {
  return { ...face, actions: withLink(face.actions ?? [], LINK_ACTION) };
}

/** The sessions on this machine that were started from this issue. */
function sessionsOf(at: World, issueId: string): ExtensionSession[] {
  return at.api
    .sessions()
    .filter((session) => at.state.links[session.id]?.includes(issueId) === true);
}

/**
 * An issue that has already become a session, marked as one.
 *
 * Nearly always an issue is worked on once: a second pick is a slip, and two
 * sessions would then chase the same error without knowing of each other. So
 * the card is tinted and says which session it is — prifly puts a chip on it
 * that opens that session — and picking it asks first: typing anything into
 * that row starts another session anyway, for the times that is wanted.
 */
export function alreadyStarted(
  face: LaunchChoice,
  shortId: string,
  sessions: ExtensionSession[],
): LaunchChoice {
  if (sessions.length === 0) return face;
  const names = sessions.map((session) => `“${clip(session.title, 50)}”`).join(", ");
  return {
    ...face,
    started: true,
    detail: `${shortId} · Already a session: ${names}`,
    input: {
      title: `Already a session: ${names}. Type “again” to start another one anyway.`,
      placeholder: "again",
    },
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
export async function launch(
  _launchId: string,
  key: string,
  input: string,
  how?: { again: boolean },
): Promise<Launch> {
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
  // Nothing typed means the issue was picked without being asked — the Start
  // button of an issue opened for reading. One that is already a session is
  // started again only when the reader answered the row that asks, or chose
  // "New session from this card…" on one of its sessions.
  const already = sessionsOf(at, key);
  if (already.length > 0 && input === "" && how?.again !== true) {
    const issue = at.issues.find((entry) => entry.id === key) ?? at.linked.get(key);
    return {
      prompt: "",
      message: `${issue?.shortId ?? "This issue"} is already a session: “${already[0]?.title ?? ""}” — open it from the chip on its card. Pick the issue on the board and type “again” to start another one anyway.`,
    };
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
  linkIssue(at.state, sessionId, key);
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
export async function action(
  key: string,
  actionId: string,
  picked?: ActionPicked,
): Promise<string> {
  const at = here();
  if (actionId === LINK_ACTION.id) {
    // A prifly without the session picker calls this with nothing picked.
    if (picked === undefined) throw new Error("This prifly cannot pick a session yet: update it.");
    return await link(at, key, picked.sessionId);
  }
  if (actionId.startsWith(UNLINK_PREFIX))
    return await unlink(at, key, actionId.slice(UNLINK_PREFIX.length));
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

/**
 * A session that was not started from the issue, given its chip anyway —
 * beside the chips it already has: one session often chases errors that
 * share a cause, like a failed backup step and the failed upload behind it.
 */
async function link(at: World, key: string, sessionId: string): Promise<string> {
  linkIssue(at.state, sessionId, key);
  await writeState(at.api.folder, at.state);
  const issue = at.issues.find((entry) => entry.id === key) ?? at.linked.get(key);
  if (issue !== undefined) at.linked.set(key, issue);
  show();
  at.api.log("linked", { issue: key, session: sessionId.slice(0, 8) });
  const title = at.api.sessions().find((session) => session.id === sessionId)?.title;
  return `Linked ${issue?.shortId ?? key} to ${title ?? sessionId.slice(0, 8)}.`;
}

/** The chip's menu id prefix for taking it off its session; the full session id follows. */
const UNLINK_PREFIX = "unlink:";

function unlinkAction(sessionId: string): DecorationAction {
  return { id: `${UNLINK_PREFIX}${sessionId}`, label: "Unlink from this session" };
}

/** A link made by mistake, undone from the chip: the issue itself is left alone in Sentry. */
async function unlink(at: World, key: string, sessionId: string): Promise<string> {
  unlinkIssue(at.state, sessionId, key);
  await writeState(at.api.folder, at.state);
  show();
  at.api.log("unlinked", { issue: key, session: sessionId.slice(0, 8) });
  const issue = at.linked.get(key) ?? at.issues.find((entry) => entry.id === key);
  const title = at.api.sessions().find((session) => session.id === sessionId)?.title;
  return `Unlinked ${issue?.shortId ?? key} from ${title ?? sessionId.slice(0, 8)}.`;
}

function here(): World {
  if (world === null) throw new Error("The Sentry extension is not running");
  return world;
}

function message(caught: unknown): string {
  return caught instanceof Error ? caught.message : String(caught);
}
