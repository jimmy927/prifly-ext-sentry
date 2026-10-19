/**
 * What this extension knows while it runs, and what it keeps between runs.
 *
 * The plain settings come from prifly's Extensions page (`api.settings`); what
 * the extension remembers — the organization and sort picked in the chooser,
 * which session was started from which issue, which folder each project's
 * sessions were last started in — lives in prifly's database (`api.state`);
 * the login token is prifly's vault (`auth.ts`). All of it moves with prifly's
 * data. The only files this extension writes are the saved events under
 * `issues/`, none in git. A prifly that lacks settings, state or the vault
 * runs nothing (`supported`).
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { findLogin, type Login } from "./auth";
import {
  type Attempt,
  DEFAULT_START_SESSIONS,
  type StartSessions,
  startSessionsFrom,
} from "./auto-start";
import { type Checkout, checkoutFor } from "./checkout";
import { CHOICE_KEYS, type Choices, parseChoices, stateStore } from "./choices";
import type { ExtensionApi, LaunchSpark } from "./prifly-api";
import { obj, str } from "./read";
import { ensureRegion, orgCreds } from "./region";
import {
  type CodeMapping,
  type Creds,
  codeMappings,
  type Issue,
  issueDetail,
  issueStats,
  organizationIssues,
  SentryError,
  type Sort,
  whoami,
} from "./sentry";
import { settingsRaw, type Values } from "./settings";

export { type Choice, type Choices, parseChoices } from "./choices";

export type Config = {
  /** The organization's slug: `your-org`. "" until chosen. */
  org: string;
  /** `https://sentry.io`, or a self-hosted Sentry's address. */
  baseUrl: string;
  /**
   * Sentry project slug → a folder its sessions always start in. Optional and
   * usually empty: the folder is found by itself (`checkout.ts`).
   */
  projects: Record<string, string>;
  /** Sentry search syntax for the chooser: `is:unresolved` by default. */
  query: string;
  /** How far back an issue must have been seen to be listed: `14d`. */
  period: string;
  sort: Sort;
  refreshSeconds: number;
  /** Whether new errors start a session by themselves (`auto-start.ts`); off by default. */
  startSessions: StartSessions;
};

export type State = {
  /** The issues (by id) each session was started from or linked to, oldest first. */
  links: Record<string, string[]>;
  /**
   * Issue id → when it was last linked to a session (ms). Kept for as long as any
   * session links the issue, so auto-start knows an issue was worked even after
   * its session left prifly's list. A link without a time (state from before
   * times were kept) counts as linked for good.
   */
  linkedAt: Record<string, number>;
  /** Sentry project slug → the checkout its last session was started in. */
  folders: Record<string, string>;
  /** Issue id → the last try at starting a session from it by itself, kept a day. */
  attempted: Record<string, Attempt>;
};

export type World = {
  api: ExtensionApi;
  /** What takes effect: the Extensions page's settings, with the chooser's choices on top (`effectiveConfig`). */
  config: Config;
  /** What the reader picked in the chooser, kept in `api.state`'s `choices` document. */
  choices: Choices;
  login: Login | null;
  state: State;
  /** What the chooser lists: the organization's issues, newest or busiest first. */
  issues: Issue[];
  /** Sentry's code mappings, read with the issues; empty when the token may not read them. */
  mappings: CodeMapping[];
  /** When the issues were last read; 0 for never, or for "read them again". */
  loadedAt: number;
  /** The issues on sessions' banners, by id, whatever their status now. */
  linked: Map<string, Issue>;
  /** Each listed issue's bars, by id, one per `SPARK_PERIODS` entry; empty when Sentry would not say. */
  sparks: Map<string, LaunchSpark[]>;
};

const SORTS: readonly Sort[] = ["date", "new", "freq", "user"];

/** `~/src/app` → that folder under the home folder; anything else as it is. */
export function expandHome(path: string, home: string): string {
  if (path === "~") return home;
  return path.startsWith("~/") ? join(home, path.slice(2)) : path;
}

/**
 * The settings (as `settingsRaw` gives them), read tolerantly: a missing or
 * mistyped field takes its default, and a project pinned to anything but a
 * folder name is dropped. `startSessions` is left at its defaults here;
 * `effectiveConfig` sets it from the settings.
 */
export function parseConfig(raw: unknown, home: string): Config {
  const config = obj(raw);
  const projects: Record<string, string> = {};
  for (const [slug, path] of Object.entries(obj(config["projects"]))) {
    const folder = str(path).trim();
    if (slug !== "" && typeof path === "string" && folder !== "") {
      projects[slug] = expandHome(folder, home);
    }
  }
  const sort = SORTS.find((name) => name === config["sort"]) ?? "date";
  const refresh = typeof config["refreshSeconds"] === "number" ? config["refreshSeconds"] : 120;
  return {
    org: str(config["org"]),
    baseUrl: (str(config["baseUrl"]) || "https://sentry.io").replace(/\/+$/, ""),
    projects,
    query: typeof config["query"] === "string" ? config["query"] : "is:unresolved",
    period: str(config["period"]) || "14d",
    sort,
    refreshSeconds: Math.max(30, refresh),
    startSessions: { ...DEFAULT_START_SESSIONS, levels: [...DEFAULT_START_SESSIONS.levels] },
  };
}

export function parseState(raw: unknown): State {
  const state = obj(raw);
  return {
    links: issueLists(state["links"]),
    linkedAt: times(state["linkedAt"]),
    folders: strings(state["folders"]),
    attempted: attempts(state["attempted"]),
  };
}

/** The tries at starting a session by itself, each with a time; anything else dropped. */
function attempts(raw: unknown): Record<string, Attempt> {
  const kept: Record<string, Attempt> = {};
  for (const [issueId, value] of Object.entries(obj(raw))) {
    const attempt = obj(value);
    const at = attempt["at"];
    if (issueId !== "" && typeof at === "number" && Number.isFinite(at)) {
      kept[issueId] = { at, started: attempt["started"] === true };
    }
  }
  return kept;
}

/**
 * Each session's issue ids. State from before a session could carry
 * several issues holds one id as a string; it is read as a list of one.
 */
function issueLists(raw: unknown): Record<string, string[]> {
  const kept: Record<string, string[]> = {};
  for (const [session, value] of Object.entries(obj(raw))) {
    const ids = (Array.isArray(value) ? value : [value]).filter(
      (id): id is string => typeof id === "string" && id !== "",
    );
    if (ids.length > 0) kept[session] = [...new Set(ids)];
  }
  return kept;
}

/** The issue added to the session's, once; the ones it already carries stay. */
export function linkIssue(
  state: State,
  sessionId: string,
  issueId: string,
  now: number = Date.now(),
): void {
  const ids = state.links[sessionId] ?? [];
  if (!ids.includes(issueId)) state.links[sessionId] = [...ids, issueId];
  state.linkedAt[issueId] = now;
}

/** The issue taken off the session; a session left with none is forgotten. */
export function unlinkIssue(state: State, sessionId: string, issueId: string): void {
  const ids = (state.links[sessionId] ?? []).filter((id) => id !== issueId);
  if (ids.length === 0) delete state.links[sessionId];
  else state.links[sessionId] = ids;
  // The issue is no longer worked, unless another session still carries it.
  if (!Object.values(state.links).some((other) => other.includes(issueId))) {
    delete state.linkedAt[issueId];
  }
}

/** Issue id → finite time, anything else dropped. */
function times(raw: unknown): Record<string, number> {
  const kept: Record<string, number> = {};
  for (const [issueId, value] of Object.entries(obj(raw))) {
    if (typeof value === "number" && Number.isFinite(value)) kept[issueId] = value;
  }
  return kept;
}

/** An object's non-empty string values, by key; anything else dropped. */
function strings(raw: unknown): Record<string, string> {
  const kept: Record<string, string> = {};
  for (const [key, value] of Object.entries(obj(raw))) {
    if (typeof value === "string" && value !== "") kept[key] = value;
  }
  return kept;
}

/** The token and the server, when there is a login. For calls that name no organization (who you are, the organization list). */
export function creds(world: World): Creds | null {
  return world.login === null ? null : { baseUrl: world.config.baseUrl, token: world.login.token };
}

/** Logged in and an organization chosen: everything else is setup. */
export function ready(world: World): boolean {
  return creds(world) !== null && world.config.org !== "";
}

/** Where a project's sessions start, from everything this machine and Sentry know now. */
export function checkoutOf(world: World, project: string): Checkout {
  return checkoutFor(project, world.mappings, {
    pinned: world.config.projects,
    remembered: world.state.folders,
    sessionFolders: world.api.sessions().map((session) => session.cwd),
  });
}

/**
 * The code mappings, or none when Sentry will not give them: the folder is
 * then found by the project's name or left to the New session form.
 */
async function mappingsOrNone(world: World, auth: Creds): Promise<CodeMapping[]> {
  try {
    return await codeMappings(auth, world.config.org);
  } catch (caught) {
    world.api.log("code_mappings_failed", {
      message: caught instanceof Error ? caught.message : String(caught),
    });
    return [];
  }
}

/** How long a start waits for Sentry to say whose token the vault holds. */
const NAME_WAIT_MS = 5000;

/**
 * The vault entry holds only the token, so a login read from it has no name.
 * Ask Sentry, the way logging in did. If that fails or is slow (offline,
 * Sentry down) the login keeps an empty name, which shows the neutral label;
 * the log says why, never the token.
 */
export async function withUser(
  api: ExtensionApi,
  config: { baseUrl: string },
  login: Login | null,
): Promise<Login | null> {
  if (login === null || login.user !== "") return login;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const user = await Promise.race([
      whoami({ baseUrl: config.baseUrl, token: login.token }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("timed out")), NAME_WAIT_MS);
      }),
    ]);
    return { ...login, user };
  } catch (caught) {
    const message = caught instanceof Error ? caught.message : "failed";
    api.log("user_name_failed", { message: message.replaceAll(login.token, "[token]") });
    return login;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Whether this prifly can run the extension: it keeps the settings
 * (`api.settings`), the state (`api.state`) and files a login token in the
 * vault (`api.vault.file` and `forget`, the "vault-file" feature). Otherwise
 * nothing runs but the row that says to update prifly (`setup.ts`).
 */
export function supported(api: ExtensionApi): boolean {
  const features = api.features ?? [];
  return (
    features.includes("settings") &&
    api.settings !== undefined &&
    features.includes("state") &&
    api.state !== undefined &&
    features.includes("vault-file") &&
    typeof api.vault?.file === "function" &&
    typeof api.vault.forget === "function"
  );
}

/**
 * The world at start. On a prifly that is not `supported` it is empty and
 * nothing is read: no state, no vault, no Sentry.
 */
export async function load(api: ExtensionApi): Promise<World> {
  const store = supported(api) ? api.state : undefined;
  const choices = store === undefined ? {} : parseChoices(await store.get("choices"));
  const state = parseState(store === undefined ? undefined : await store.get(STATE_DOC));
  const config = effectiveConfig(api.settings ?? {}, choices);
  return {
    api,
    config,
    choices,
    login: store === undefined ? null : await withUser(api, config, await findLogin(api)),
    state,
    issues: [],
    mappings: [],
    loadedAt: 0,
    linked: new Map(),
    sparks: new Map(),
  };
}

/** The most Sentry's issue list gives in one page. */
const LIMIT = 100;

/** The periods a card's bars cover, in the order the board's switch offers them. */
export const SPARK_PERIODS = ["1h", "24h", "7d"] as const;

/** Issues per stats request, as Sentry's own issue stream asks for them. */
const STATS_BATCH = 25;

/**
 * What Sentry has now: the chooser's issues across the organization, which
 * repo each project's code is in, and the issue behind each session's chip —
 * read one by one, since a resolved issue is not in the unresolved list but
 * its chip should still say it is resolved.
 */
export async function reload(world: World): Promise<void> {
  if (!ready(world)) return;
  await ensureRegion(world);
  const auth = orgCreds(world);
  if (auth === null) return;
  const { org, query, period, sort } = world.config;
  const [issues, mappings] = await Promise.all([
    organizationIssues(auth, org, { query, period, sort, limit: LIMIT }),
    mappingsOrNone(world, auth),
  ]);
  world.issues = sortIssues(issues, sort);
  world.mappings = mappings;
  world.sparks = await sparksOf(world, auth, org);
  world.loadedAt = Date.now();
  const known = new Set(world.api.sessions().map((session) => session.id));
  const wanted = new Set(
    Object.entries(world.state.links)
      .filter(([session]) => known.has(session))
      .flatMap(([, issues]) => issues),
  );
  const linked = new Map<string, Issue>();
  for (const id of wanted) {
    const found = world.issues.find((issue) => issue.id === id) ?? (await gone(auth, org, id));
    if (found !== null) linked.set(id, found);
  }
  world.linked = linked;
}

/**
 * The listed issues' bars over each period. Bars are extra: when Sentry will
 * not give them, the board still comes, only without its bars — the counts
 * then stay in each card's detail line.
 */
async function sparksOf(
  world: World,
  auth: Creds,
  org: string,
): Promise<Map<string, LaunchSpark[]>> {
  const ids = world.issues.map((issue) => issue.id);
  const batches: string[][] = [];
  for (let at = 0; at < ids.length; at += STATS_BATCH)
    batches.push(ids.slice(at, at + STATS_BATCH));
  try {
    const periods = await Promise.all(
      SPARK_PERIODS.map(async (period) => {
        const found = await Promise.all(
          batches.map((batch) => issueStats(auth, org, batch, period)),
        );
        return { period, counts: new Map(found.flatMap((map) => [...map])) };
      }),
    );
    const sparks = new Map<string, LaunchSpark[]>();
    for (const id of ids) {
      sparks.set(
        id,
        periods.map(({ period, counts }) => {
          const bars = counts.get(id) ?? [];
          return { period, counts: bars, total: bars.reduce((sum, count) => sum + count, 0) };
        }),
      );
    }
    return sparks;
  } catch (caught) {
    world.api.log("sparks_failed", {
      message: caught instanceof Error ? caught.message : String(caught),
    });
    return new Map();
  }
}

/** An issue that is not in the list: read on its own, or null once Sentry has deleted it. */
async function gone(auth: Creds, org: string, id: string): Promise<Issue | null> {
  try {
    return (await issueDetail(auth, org, id)).issue;
  } catch (caught) {
    if (caught instanceof SentryError && caught.status === 404) return null;
    throw caught;
  }
}

/** Several projects' lists as one, in the order Sentry sorted each of them. */
export function sortIssues(issues: Issue[], sort: Sort): Issue[] {
  const key = (issue: Issue): number => {
    if (sort === "freq") return issue.count;
    if (sort === "user") return issue.userCount;
    return Date.parse(sort === "new" ? issue.firstSeen : issue.lastSeen) || 0;
  };
  return [...issues].sort((a, b) => key(b) - key(a));
}

/** A setting's text the way `settingsRaw` reads it. */
function settingText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/** What takes effect: the settings, with each chooser choice the reader has not since overruled. */
export function effectiveConfig(values: Values, choices: Choices): Config {
  const raw = settingsRaw(values);
  for (const key of CHOICE_KEYS) {
    const choice = choices[key];
    if (choice !== undefined && choice.over === settingText(values[key])) raw[key] = choice.value;
  }
  const config = parseConfig(raw, homedir());
  config.startSessions = startSessionsFrom(values);
  return config;
}

/** Reads the settings again, after the reader changed one. */
export function applySettings(world: World): void {
  world.config = effectiveConfig(world.api.settings ?? {}, world.choices);
}

/**
 * A choice made in the chooser (organization, sort): in force now and kept in
 * prifly's database (the `choices` document), so it holds across restarts.
 */
export async function choose(world: World, change: { org?: string; sort?: Sort }): Promise<void> {
  Object.assign(world.config, change);
  const values = world.api.settings ?? {};
  const made: Choices = {};
  for (const key of CHOICE_KEYS) {
    const value = change[key];
    if (value !== undefined) made[key] = { value, over: settingText(values[key]) };
  }
  const kept = await stateStore(world.api).update<unknown>("choices", (current) => ({
    ...parseChoices(current),
    ...made,
  }));
  world.choices = parseChoices(kept);
}

/** The document the links and remembered folders live in. */
const STATE_DOC = "state";

/**
 * Change the links and remembered folders, on the stored document inside
 * `update`, so two writes at once cannot lose each other's change;
 * `world.state` then takes the result.
 */
export async function changeState(world: World, mutate: (state: State) => void): Promise<void> {
  const kept = await stateStore(world.api).update<unknown>(STATE_DOC, (current) => {
    const next = parseState(current);
    mutate(next);
    return next;
  });
  Object.assign(world.state, parseState(kept));
}
