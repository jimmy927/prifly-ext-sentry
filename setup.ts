/**
 * Setting the extension up, in the place you go to pick an issue.
 *
 * There is no settings screen. Not logged in, the chooser lists the way to
 * log in; logged in with no organization chosen, it lists the organizations;
 * with no project mapped to a checkout, it lists the projects, and picking
 * one asks which folder it is checked out in. After that it lists the issues,
 * with a few rows kept beside them for changing any of it. Each setup row
 * starts nothing — it answers with an empty prompt — so the list simply comes
 * again, one step further on.
 */

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  findLogin,
  forgetLogin,
  looksLikeToken,
  readClirc,
  tokenPageUrl,
  writeLogin,
} from "./auth";
import { openBrowser } from "./open-browser";
import type { Launch, LaunchChoice } from "./prifly-api";
import { organizations, projects, whoami } from "./sentry";
import { creds, expandHome, type World, writeConfig, writeState } from "./world";

const KEYS = {
  open: "setup:open-token-page",
  token: "setup:paste-token",
  org: "setup:org:",
  project: "setup:project:",
  addProject: "setup:add-project",
  switchOrg: "setup:switch-org",
  doneAdding: "setup:done-adding",
  sort: "setup:sort",
  logout: "setup:log-out",
} as const;

export function isSetupKey(key: string): boolean {
  return key.startsWith("setup:");
}

/** The rows before any issue: the login, the organization, a project. Null once all are settled. */
export async function setupChoices(world: World): Promise<LaunchChoice[] | null> {
  if (world.login === null) return loginRows(world);
  if (world.config.org === "") return await orgRows(world);
  if (Object.keys(world.config.projects).length === 0 || world.state.addingProject) {
    return await projectRows(world);
  }
  return null;
}

const SORT_NAMES = { date: "last seen", new: "first seen", freq: "events", user: "users" } as const;

/** Kept beside the issues, for a reader who wants to change something. */
export function setupTail(world: World): LaunchChoice[] {
  const mapped = Object.entries(world.config.projects)
    .map(([slug, folder]) => `${slug} → ${folder}`)
    .join(", ");
  const next = world.config.sort === "freq" ? "last seen" : "events";
  return [
    {
      key: KEYS.sort,
      title: `Sort by ${next}`,
      group: "prifly",
      detail: `Now by ${SORT_NAMES[world.config.sort]}`,
      tone: "muted",
    },
    {
      key: KEYS.addProject,
      title: "Map a project…",
      group: "prifly",
      detail: mapped,
      tone: "muted",
    },
    {
      key: KEYS.switchOrg,
      title: "Switch organization…",
      group: "prifly",
      detail: world.config.org,
      tone: "muted",
    },
    {
      key: KEYS.logout,
      title: "Log out of Sentry",
      group: "prifly",
      detail: loginLine(world),
      tone: "muted",
    },
  ];
}

function loginLine(world: World): string {
  const login = world.login;
  if (login === null) return "";
  const who = login.user === "" ? "" : ` as ${login.user}`;
  return `Signed in${who} with the token from ${login.source}`;
}

/**
 * What "Create New Token" needs, in the order Sentry's own page shows the
 * permissions: Name, then Project, Team, Release, Issue & Event,
 * Organization, Member, Alerts. Kept in one place so the chooser row and the
 * message shown after opening the page never drift apart.
 */
const TOKEN_PERMISSIONS =
  "Name: prifly. Project: Read. Team: No Access. Release: No Access. " +
  "Issue & Event: Read & Write (Read alone works, but Resolve/Archive/Unresolve then fail with 403). " +
  "Organization: Read. Member: No Access. Alerts: No Access.";

function loginRows(world: World): LaunchChoice[] {
  return [
    {
      key: KEYS.open,
      title: "1. Open Sentry's auth token page",
      group: "Log in",
      detail: `Sign in as you always do, then “Create New Token” with — ${TOKEN_PERMISSIONS}`,
      tone: "info",
      url: tokenPageUrl(world.config.baseUrl),
    },
    {
      key: KEYS.token,
      title: "2. Paste the token Sentry shows you",
      group: "Log in",
      detail:
        "Sentry shows it once. It is checked there and then and kept on this machine only (auth.json, readable by you alone).",
      tone: "info",
      input: { title: "Your Sentry auth token", placeholder: "sntryu_…" },
    },
  ];
}

async function orgRows(world: World): Promise<LaunchChoice[]> {
  const auth = creds(world);
  if (auth === null) return loginRows(world);
  const orgs = await organizations(auth);
  if (orgs.length === 0) throw new Error("That Sentry token can see no organization.");
  return orgs.map((org) => ({
    key: `${KEYS.org}${org.slug}`,
    title: org.name,
    group: "Choose an organization",
    detail: org.slug,
    tone: "info",
  }));
}

/** Where a project is probably checked out: `~/<slug>`, `~/src/<slug>`, `~/code/<slug>`. */
export function guessFolder(slug: string, home = homedir()): string {
  const candidates = [join(home, slug), join(home, "src", slug), join(home, "code", slug)];
  return candidates.find((folder) => existsSync(join(folder, ".git"))) ?? "";
}

async function projectRows(world: World): Promise<LaunchChoice[]> {
  const auth = creds(world);
  if (auth === null) return loginRows(world);
  const found = await projects(auth, world.config.org);
  if (found.length === 0)
    throw new Error(`${world.config.org} has no projects this token can see.`);
  const rows: LaunchChoice[] = found.map((project) => {
    const mapped = world.config.projects[project.slug];
    const guess = guessFolder(project.slug);
    const detail =
      mapped !== undefined
        ? `Now ${mapped}`
        : guess === ""
          ? "Not mapped yet"
          : `Probably ${guess}`;
    return {
      key: `${KEYS.project}${project.slug}`,
      title: project.name,
      group: "Map a Sentry project to its checkout",
      detail,
      tone: mapped === undefined ? "info" : "muted",
      input: {
        title: `Which folder is ${project.slug} checked out in?`,
        placeholder: guess === "" ? "/home/you/src/project" : `${guess} (leave empty for this)`,
      },
    };
  });
  if (Object.keys(world.config.projects).length > 0) {
    rows.push({
      key: KEYS.doneAdding,
      title: "Back to the issues",
      group: "prifly",
      tone: "muted",
    });
  }
  return rows;
}

/** Carry out one of those rows. Null when the key is not one of them. */
export async function runSetup(world: World, key: string, input: string): Promise<Launch | null> {
  if (key === KEYS.open) return await openTokenPage(world);
  if (key === KEYS.token) return await saveToken(world, input);
  if (key.startsWith(KEYS.org)) return await chooseOrg(world, key.slice(KEYS.org.length));
  if (key.startsWith(KEYS.project)) {
    return await mapProject(world, key.slice(KEYS.project.length), input);
  }
  if (key === KEYS.addProject || key === KEYS.doneAdding) {
    world.state.addingProject = key === KEYS.addProject;
    await writeState(world.api.folder, world.state);
    return { prompt: "", message: "" };
  }
  if (key === KEYS.sort) return await toggleSort(world);
  if (key === KEYS.switchOrg) return await switchOrg(world);
  if (key === KEYS.logout) return await logOut(world);
  return null;
}

/** What to say once the token page is (or is not) open — kept pure so it is testable without a browser. */
export function tokenPageMessage(opened: boolean, url: string): string {
  return opened
    ? `${TOKEN_PERMISSIONS} Then pick “2. Paste the token”.`
    : `Open this, create a token, then pick “2. Paste the token”: ${url}\n\n${TOKEN_PERMISSIONS}`;
}

async function openTokenPage(world: World): Promise<Launch> {
  const url = tokenPageUrl(world.config.baseUrl);
  const opened = await openBrowser(url);
  world.api.log("token_page", { opened });
  return { prompt: "", message: tokenPageMessage(opened, url) };
}

async function saveToken(world: World, input: string): Promise<Launch> {
  const token = input.trim();
  if (!looksLikeToken(token)) {
    throw new Error(
      "That is not a Sentry token — paste the one word starting sntryu_ that Sentry showed you.",
    );
  }
  // Asked of Sentry before it is kept: a token that does not work should fail
  // here, where the reader is looking, not quietly on the next refresh.
  const user = await whoami({ baseUrl: world.config.baseUrl, token });
  await writeLogin(world.api.folder, token, user);
  world.login = { token, user, source: "auth.json" };
  world.api.log("logged_in", { user });
  return { prompt: "", message: `Logged in as ${user}.` };
}

async function chooseOrg(world: World, slug: string): Promise<Launch> {
  world.config.org = slug;
  await writeConfig(world.api.folder, world.config);
  world.api.log("org_chosen", { org: slug });
  return { prompt: "", message: `Showing ${slug}. Now map a project to its checkout.` };
}

async function mapProject(world: World, slug: string, input: string): Promise<Launch> {
  const typed = input.trim().replace(/ \(leave empty for this\)$/, "");
  const folder = typed === "" ? guessFolder(slug) : expandHome(typed, homedir());
  if (folder === "") throw new Error(`Type the folder ${slug} is checked out in.`);
  if (!existsSync(folder)) throw new Error(`There is no folder ${folder} on this machine.`);
  world.config.projects[slug] = folder;
  world.state.addingProject = false;
  await Promise.all([
    writeConfig(world.api.folder, world.config),
    writeState(world.api.folder, world.state),
  ]);
  world.api.log("project_mapped", { project: slug, folder });
  return { prompt: "", message: `${slug} issues start sessions in ${folder}.` };
}

/** Projects belong to an organization, so their mapping goes with it. */
async function switchOrg(world: World): Promise<Launch> {
  world.config.org = "";
  world.config.projects = {};
  world.issues = [];
  world.loadedAt = 0;
  await writeConfig(world.api.folder, world.config);
  return { prompt: "", message: "" };
}

async function toggleSort(world: World): Promise<Launch> {
  world.config.sort = world.config.sort === "freq" ? "date" : "freq";
  await writeConfig(world.api.folder, world.config);
  world.issues = [];
  world.loadedAt = 0;
  return { prompt: "", message: `Sorted by ${SORT_NAMES[world.config.sort]}.` };
}

async function logOut(world: World): Promise<Launch> {
  await forgetLogin(world.api.folder);
  world.login = await findLogin(world.api.folder, Bun.env, await readClirc());
  world.issues = [];
  world.loadedAt = 0;
  world.linked = new Map();
  world.api.log("logged_out", { still: world.login?.source ?? "none" });
  if (world.login !== null) {
    return {
      prompt: "",
      message: `The token pasted here is gone, but ${world.login.source} still has one — remove it there to log out fully.`,
    };
  }
  return { prompt: "", message: "Logged out. The token on this machine is gone." };
}
