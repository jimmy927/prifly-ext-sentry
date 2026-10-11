/**
 * What this extension knows while it runs, and what it keeps between runs.
 *
 * Three small files sit next to this one, none of them in git: `config.json`
 * (the organization and how the list is sorted), `auth.json` (the reader's
 * own token, only on a prifly without a vault — `auth.ts`), and `state.json` (which
 * session was started from which issue, and which folder each project's
 * sessions were last started in). Saved events go under `issues/`, also out
 * of git.
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { type Clirc, findLogin, type Login, readClirc } from "./auth";
import {
  type Attempt,
  hasSettings,
  parseStartSessions,
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
import { fileOnlyKeys, overlaySettings } from "./settings";

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
   * its session left prifly's list. A link without a time (a `state.json` from
   * before this) counts as linked for good.
   */
  linkedAt: Record<string, number>;
  /** Sentry project slug → the checkout its last session was started in. */
  folders: Record<string, string>;
  /** Issue id → the last try at starting a session from it by itself, kept a day. */
  attempted: Record<string, Attempt>;
};

export type World = {
  api: ExtensionApi;
  /** What takes effect: the Extensions page's settings over `file`, or `file` alone on an older prifly. */
  config: Config;
  /** What `config.json` holds; the only part of `config` that is written back to it. */
  file: Config;
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
 * config.json, read tolerantly: a missing or mistyped field takes its default,
 * and a project pinned to anything but a folder name is dropped.
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
    startSessions: parseStartSessions(config["startSessions"]),
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
 * Each session's issue ids. A `state.json` from before a session could carry
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
  const raw = await readConfigFile(api.folder);
  const file = parseConfig(raw, Bun.env, clirc, homedir());
  const config = settingsConfig(api, raw, clirc) ?? file;
  if (api.settings !== undefined && hasSettings(api)) {
    const waiting = fileOnlyKeys(raw, api.settings);
    if (waiting.length > 0) {
      api.log("config_json_in_use", {
        keys: waiting.join(","),
        message:
          "These come from config.json because their setting is still at its default; enter them in prifly's Extensions dialog (Sentry issues) to move them with prifly's data.",
      });
    }
  }
  return {
    api,
    config,
    file,
    login: await findLogin(api.folder, Bun.env, clirc, api),
    state: await readState(api.folder),
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

async function readConfigFile(folder: string): Promise<unknown> {
  return await Bun.file(join(folder, "config.json"))
    .json()
    .catch(() => ({}));
}

/**
 * The effective config where this prifly keeps settings: `config.json`'s
 * values with the settings laid over them (`settings.ts`), and the
 * auto-start block from the settings alone. Null on a prifly without them.
 */
export function settingsConfig(api: ExtensionApi, fileRaw: unknown, clirc: Clirc): Config | null {
  if (api.settings === undefined || !hasSettings(api)) return null;
  const config = parseConfig(overlaySettings(fileRaw, api.settings), Bun.env, clirc, homedir());
  config.startSessions = startSessionsFrom(api.settings);
  return config;
}

/** Re-reads `config.json` and lays the current settings over it, after the reader changed one. */
export async function applySettings(world: World): Promise<void> {
  const clirc = await readClirc();
  const raw = await readConfigFile(world.api.folder);
  world.file = parseConfig(raw, Bun.env, clirc, homedir());
  const config = settingsConfig(world.api, raw, clirc);
  if (config !== null) world.config = config;
}

/** Writes `config.json`: only what the file holds, never the settings laid over it. */
async function writeConfig(folder: string, config: Config): Promise<void> {
  await Bun.write(join(folder, "config.json"), JSON.stringify(config, null, 2));
}

/**
 * A choice made in the chooser (organization, sort): kept in `config.json`
 * and in force now. Where a setting is set to something else, the setting
 * wins again the next time the reader changes any setting.
 */
export async function chooseInFile(world: World, change: Partial<Config>): Promise<void> {
  Object.assign(world.config, change);
  Object.assign(world.file, change);
  await writeConfig(world.api.folder, world.file);
}

export async function readState(folder: string): Promise<State> {
  const raw: unknown = await Bun.file(join(folder, "state.json"))
    .json()
    .catch(() => ({}));
  return parseState(raw);
}

export async function writeState(folder: string, state: State): Promise<void> {
  await Bun.write(join(folder, "state.json"), JSON.stringify(state, null, 2));
}
