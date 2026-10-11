/**
 * What this extension knows while it runs, and what it keeps between runs.
 *
 * The only files this extension keeps in its folder are `auth.json` (the
 * reader's own token, only on a prifly without a vault or when its move into
 * the vault was declined — `auth.ts`), the `vault-declined` marker, and the
 * saved events under `issues/`, none in git. The plain settings come from
 * prifly's Extensions page (`api.settings`); what the extension remembers —
 * the organization and sort picked in the chooser, which session was started
 * from which issue, which folder each project's sessions were last started in
 * — lives in prifly's database (`api.state`), so it moves with prifly. A
 * prifly without either gets defaults and memory for that run, never files
 * (the `needs_newer_prifly` log).
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { type Clirc, findLogin, type Login, readClirc } from "./auth";
import {
  type Attempt,
  DEFAULT_START_SESSIONS,
  hasSettings,
  type StartSessions,
  startSessionsFrom,
} from "./auto-start";
import { type Checkout, checkoutFor } from "./checkout";
import type { ExtensionApi, LaunchSpark } from "./prifly-api";
import { obj, str } from "./read";
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
} from "./sentry";
import { SETTING_DEFAULTS, settingsRaw, type Values } from "./settings";

export type Config = {
  /** The organization's slug: `morpheus-0r`. "" until chosen. */
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

/** `~/src/odi` → `/home/jimmy/src/odi`; anything else as it is. */
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
export function parseConfig(
  raw: unknown,
  env: Record<string, string | undefined>,
  clirc: Clirc,
  home: string,
): Config {
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
    org: str(config["org"]) || env["SENTRY_ORG"] || clirc.org,
    baseUrl: (
      str(config["baseUrl"]) ||
      env["SENTRY_URL"] ||
      clirc.url ||
      "https://sentry.io"
    ).replace(/\/+$/, ""),
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

/** The token and the server, when there is a login. */
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

export async function load(api: ExtensionApi): Promise<World> {
  const clirc = await readClirc();
  // Settings and state live in prifly's database. A prifly without them gets
  // no files instead: defaults, and state that lasts until the extension stops.
  const missing = [hasSettings(api) ? "" : "settings", hasState(api) ? "" : "state"].filter(
    (name) => name !== "",
  );
  if (missing.length > 0) {
    api.log("needs_newer_prifly", {
      missing: missing.join(","),
      message:
        "This extension keeps its settings and state in prifly's database; this prifly lacks that, so it runs on defaults and keeps links and choices in memory only. Update prifly.",
    });
  }
  const store = api.state;
  const stored = store !== undefined && hasState(api);
  const choices = stored ? parseChoices(await store.get("choices")) : {};
  const state = stored
    ? parseState(await store.importOnce(STATE_DOC, () => legacyState(api.folder)))
    : parseState({});
  return {
    api,
    config: effectiveConfig(settingValues(api), choices, clirc),
    choices,
    login: await findLogin(api.folder, Bun.env, clirc, api),
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
  const auth = creds(world);
  if (auth === null || !ready(world)) return;
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

/** Whether this prifly keeps extension state in its database (`api.state`). */
export function hasState(api: ExtensionApi): boolean {
  return (api.features ?? []).includes("state") && api.state !== undefined;
}

/** The settings now; the manifest's defaults on a prifly that keeps none. */
function settingValues(api: ExtensionApi): Values {
  return hasSettings(api) && api.settings !== undefined ? api.settings : SETTING_DEFAULTS;
}

/** A setting's text the way `settingsRaw` reads it. */
function settingText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * A choice made in the chooser: the `value` picked, and `over`, what the
 * setting held when it was picked. The choice stands while the setting still
 * holds that; once the reader changes the setting on the Extensions page, the
 * setting wins again.
 */
export type Choice = { value: string; over: string };
export type Choices = { org?: Choice; sort?: Choice };

const CHOICE_KEYS = ["org", "sort"] as const;

export function parseChoices(raw: unknown): Choices {
  const choices: Choices = {};
  for (const key of CHOICE_KEYS) {
    const choice = obj(obj(raw)[key]);
    if (typeof choice["value"] === "string" && typeof choice["over"] === "string") {
      choices[key] = { value: choice["value"], over: choice["over"] };
    }
  }
  return choices;
}

/** What takes effect: the settings, with each chooser choice the reader has not since overruled. */
export function effectiveConfig(values: Values, choices: Choices, clirc: Clirc): Config {
  const raw = settingsRaw(values);
  for (const key of CHOICE_KEYS) {
    const choice = choices[key];
    if (choice !== undefined && choice.over === settingText(values[key])) raw[key] = choice.value;
  }
  const config = parseConfig(raw, Bun.env, clirc, homedir());
  config.startSessions = startSessionsFrom(values);
  return config;
}

/** Reads the settings again, after the reader changed one. */
export async function applySettings(world: World): Promise<void> {
  world.config = effectiveConfig(settingValues(world.api), world.choices, await readClirc());
}

/**
 * A choice made in the chooser (organization, sort): in force now and kept in
 * prifly's database (the `choices` document), so it holds across restarts.
 * Without `api.state` it holds until the extension stops.
 */
export async function choose(world: World, change: { org?: string; sort?: Sort }): Promise<void> {
  Object.assign(world.config, change);
  const values = settingValues(world.api);
  const made: Choices = {};
  for (const key of CHOICE_KEYS) {
    const value = change[key];
    if (value !== undefined) made[key] = { value, over: settingText(values[key]) };
  }
  const store = world.api.state;
  if (store === undefined || !hasState(world.api)) {
    world.choices = { ...world.choices, ...made };
    return;
  }
  const kept = await store.update<unknown>("choices", (current) => ({
    ...parseChoices(current),
    ...made,
  }));
  world.choices = parseChoices(kept);
}

/** The document the links and remembered folders live in. */
const STATE_DOC = "state";

/**
 * Change the links and remembered folders. With `api.state` the change is
 * made on the stored document inside `update`, so two writes at once cannot
 * lose each other's change, and `world.state` then takes the result; without
 * it the change is made on `world.state` alone.
 */
export async function changeState(world: World, mutate: (state: State) => void): Promise<void> {
  const store = world.api.state;
  if (store === undefined || !hasState(world.api)) {
    mutate(world.state);
    return;
  }
  const kept = await store.update<unknown>(STATE_DOC, (current) => {
    const next = parseState(current);
    mutate(next);
    return next;
  });
  Object.assign(world.state, parseState(kept));
}

/**
 * What an older `state.json` in the extension's folder holds, for
 * `api.state.importOnce`; undefined when there is none (or it is not JSON),
 * which stores nothing. Read only when nothing was imported yet.
 */
async function legacyState(folder: string): Promise<State | undefined> {
  const file = Bun.file(join(folder, "state.json"));
  if (!(await file.exists())) return undefined;
  try {
    return parseState(await file.json());
  } catch {
    return undefined;
  }
}
