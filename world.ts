/**
 * What this extension knows while it runs, and what it keeps between runs.
 *
 * Three small files sit next to this one, none of them in git: `config.json`
 * (the organization, which Sentry project is checked out where, and how the
 * list is sorted), `auth.json` (the reader's own token, when it was pasted
 * here — `auth.ts`), and `state.json` (which session was started from which
 * issue). Saved events go under `issues/`, also out of git.
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { type Clirc, findLogin, type Login, readClirc } from "./auth";
import type { ExtensionApi } from "./prifly-api";
import { obj, str } from "./read";
import {
  type Creds,
  type Issue,
  issueDetail,
  projectIssues,
  SentryError,
  type Sort,
} from "./sentry";

export type Config = {
  /** The organization's slug: `morpheus-0r`. "" until chosen. */
  org: string;
  /** `https://sentry.io`, or a self-hosted Sentry's address. */
  baseUrl: string;
  /** Sentry project slug → the checkout its sessions work in. */
  projects: Record<string, string>;
  /** Sentry search syntax for the chooser: `is:unresolved` by default. */
  query: string;
  /** How far back an issue must have been seen to be listed: `14d`. */
  period: string;
  sort: Sort;
  refreshSeconds: number;
};

export type State = {
  /** Which issue (by id) each session was started from. */
  links: Record<string, string>;
  /** The reader asked to map another project; the chooser lists them until one is picked. */
  addingProject: boolean;
};

export type World = {
  api: ExtensionApi;
  config: Config;
  login: Login | null;
  state: State;
  /** What the chooser lists: every mapped project's issues, newest or busiest first. */
  issues: Issue[];
  /** When the issues were last read; 0 for never, or for "read them again". */
  loadedAt: number;
  /** The issues on sessions' banners, by id, whatever their status now. */
  linked: Map<string, Issue>;
};

const SORTS: readonly Sort[] = ["date", "new", "freq", "user"];

/** `~/src/odi` → `/home/jimmy/src/odi`; anything else as it is. */
export function expandHome(path: string, home: string): string {
  if (path === "~") return home;
  return path.startsWith("~/") ? join(home, path.slice(2)) : path;
}

/**
 * config.json, read tolerantly: a missing or mistyped field takes its default,
 * and a project mapped to anything but a folder name is dropped.
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
  };
}

export function parseState(raw: unknown): State {
  const state = obj(raw);
  const links: Record<string, string> = {};
  for (const [session, issue] of Object.entries(obj(state["links"]))) {
    if (typeof issue === "string" && issue !== "") links[session] = issue;
  }
  return { links, addingProject: state["addingProject"] === true };
}

/** The token and the server, when there is a login. */
export function creds(world: World): Creds | null {
  return world.login === null ? null : { baseUrl: world.config.baseUrl, token: world.login.token };
}

/** Logged in, an organization chosen and a project mapped: everything else is setup. */
export function ready(world: World): boolean {
  return (
    creds(world) !== null &&
    world.config.org !== "" &&
    Object.keys(world.config.projects).length > 0
  );
}

export async function load(api: ExtensionApi): Promise<World> {
  const clirc = await readClirc();
  return {
    api,
    config: await readConfig(api.folder, clirc),
    login: await findLogin(api.folder, Bun.env, clirc),
    state: await readState(api.folder),
    issues: [],
    loadedAt: 0,
    linked: new Map(),
  };
}

const PER_PROJECT = 100;

/**
 * What Sentry has now: the chooser's issues for every mapped project, and the
 * issue behind each session's chip — read one by one, since a resolved issue
 * is not in the unresolved list but its chip should still say it is resolved.
 */
export async function reload(world: World): Promise<void> {
  const auth = creds(world);
  if (auth === null || !ready(world)) return;
  const { org, query, period, sort } = world.config;
  const lists = await Promise.all(
    Object.keys(world.config.projects).map((project) =>
      projectIssues(auth, org, project, { query, period, sort, limit: PER_PROJECT }),
    ),
  );
  world.issues = sortIssues(lists.flat(), sort);
  world.loadedAt = Date.now();
  const known = new Set(world.api.sessions().map((session) => session.id));
  const wanted = new Set(
    Object.entries(world.state.links)
      .filter(([session]) => known.has(session))
      .map(([, issue]) => issue),
  );
  const linked = new Map<string, Issue>();
  for (const id of wanted) {
    const found = world.issues.find((issue) => issue.id === id) ?? (await gone(auth, org, id));
    if (found !== null) linked.set(id, found);
  }
  world.linked = linked;
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

export async function readConfig(folder: string, clirc: Clirc): Promise<Config> {
  const raw: unknown = await Bun.file(join(folder, "config.json"))
    .json()
    .catch(() => ({}));
  return parseConfig(raw, Bun.env, clirc, homedir());
}

export async function writeConfig(folder: string, config: Config): Promise<void> {
  await Bun.write(join(folder, "config.json"), JSON.stringify(config, null, 2));
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
