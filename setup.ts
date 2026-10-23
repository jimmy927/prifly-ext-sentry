/**
 * Setting the extension up, in the place you go to pick an issue.
 *
 * There is no settings screen. Not logged in, the chooser lists the way to
 * log in; logged in with no organization chosen, it lists the organizations.
 * After that it lists the issues of every project in it, with a few rows kept
 * beside them for changing any of it. There are no projects to map: where a
 * project is checked out is found at launch (`checkout.ts`). Each setup row
 * starts nothing — it answers with an empty prompt — so the list simply comes
 * again, one step further on.
 */

import { findLogin, looksLikeToken, removeLogin, saveLogin, tokenPageUrl } from "./auth";
import type { Launch, LaunchChoice } from "./prifly-api";
import { DEFAULT_BASE_URL, ensureRegion } from "./region";
import { organizations, whoami } from "./sentry";
import { choose, creds, supported, type World } from "./world";

const KEYS = {
  update: "setup:update-prifly",
  rejected: "setup:token-refused",
  hint: "setup:self-hosted-hint",
  open: "setup:open-token-page",
  token: "setup:paste-token",
  org: "setup:org:",
  switchOrg: "setup:switch-org",
  sort: "setup:sort",
  logout: "setup:log-out",
} as const;

export function isSetupKey(key: string): boolean {
  return key.startsWith("setup:");
}

/**
 * The rows before any issue: the login, then the organization. Null once both
 * are settled. On a prifly that is not `supported` only the Update row.
 */
export async function setupChoices(world: World): Promise<LaunchChoice[] | null> {
  if (!supported(world.api)) return [updateRow()];
  if (world.login === null) return loginRows(world);
  if (world.config.org === "") return await orgRows(world);
  return null;
}

const SORT_NAMES = { date: "last seen", new: "first seen", freq: "events", user: "users" } as const;

/** Kept beside the issues, for a reader who wants to change something. */
export function setupTail(world: World): LaunchChoice[] {
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
  return `Signed in${who} with the token in prifly's vault`;
}

/** This extension needs a prifly with settings, state and the vault: until then nothing runs. */
function updateRow(): LaunchChoice {
  return {
    key: KEYS.update,
    title: "Update prifly to use this extension",
    group: "Setup",
    detail:
      "This extension needs a prifly with extension settings, state and the vault. Update prifly, then open this list again.",
    tone: "warning",
  };
}

/**
 * The saved token is there but Sentry refuses it (revoked, expired): say so,
 * and offer the way out — a new token pasted over it, or logging out.
 */
export function rejectedRows(world: World): LaunchChoice[] {
  return [
    {
      key: KEYS.rejected,
      title: "Sentry refused the saved token",
      group: "Log in",
      detail:
        "It may have been revoked or have expired. Make a new token and paste it below, or log out to start over.",
      tone: "warning",
    },
    ...loginRows(world),
    {
      key: KEYS.logout,
      title: "Log out of Sentry",
      group: "Log in",
      detail: "Removes the refused token from prifly's vault.",
      tone: "muted",
    },
  ];
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
  const hint: LaunchChoice[] =
    world.config.baseUrl === DEFAULT_BASE_URL
      ? [
          {
            key: KEYS.hint,
            title: "Self-hosted Sentry?",
            group: "Log in",
            detail:
              "Set Base URL (“Sentry address”) in prifly's Extensions dialog (Sentry issues) first.",
            tone: "muted",
          },
        ]
      : [];
  return [
    ...hint,
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
      detail: `Sentry shows it once. It is checked there and then and kept in prifly's vault (you confirm on a card).`,
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

/** Carry out one of those rows. Null when the key is not one of them. */
export async function runSetup(world: World, key: string, input: string): Promise<Launch | null> {
  if (key === KEYS.update) {
    return {
      prompt: "",
      message: "Update prifly to use this extension, then open this list again.",
    };
  }
  if (key === KEYS.hint || key === KEYS.rejected) return { prompt: "", message: "" };
  if (key === KEYS.open) return await openTokenPage(world);
  if (key === KEYS.token) return await saveToken(world, input);
  if (key.startsWith(KEYS.org)) return await chooseOrg(world, key.slice(KEYS.org.length));
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
  // prifly's own opener, which knows the host (Windows, WSL, macOS). Without
  // it the URL is shown in the dialog to be copied.
  const { api } = world;
  let opened = false;
  if ((api.features ?? []).includes("open-url") && api.openUrl !== undefined) {
    try {
      opened = await api.openUrl(url);
    } catch {
      // A page that would not open is not worth unwinding a step for.
    }
  }
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
  const kept = await saveLogin(world.api, token, user, world.config.baseUrl);
  if (!kept.saved) {
    world.api.log("login_not_saved", { user });
    return { prompt: "", message: kept.reason };
  }
  world.login = { token, user };
  world.api.log("logged_in", { user });
  return { prompt: "", message: `Logged in as ${user}.` };
}

async function chooseOrg(world: World, slug: string): Promise<Launch> {
  await choose(world, { org: slug });
  // Which data region hosts it (EU organizations are on de.sentry.io): kept with the choice.
  await ensureRegion(world);
  world.api.log("org_chosen", { org: slug });
  return { prompt: "", message: `Showing every project in ${slug}.` };
}

/** Back to the organization list. (Folders pinned in the Project folders setting stay: the Extensions page owns them.) */
async function switchOrg(world: World): Promise<Launch> {
  await choose(world, { org: "" });
  world.issues = [];
  world.mappings = [];
  world.loadedAt = 0;
  return { prompt: "", message: "" };
}

async function toggleSort(world: World): Promise<Launch> {
  await choose(world, { sort: world.config.sort === "freq" ? "date" : "freq" });
  world.issues = [];
  world.loadedAt = 0;
  return { prompt: "", message: `Sorted by ${SORT_NAMES[world.config.sort]}.` };
}

async function logOut(world: World): Promise<Launch> {
  const remains = await removeLogin(world.api);
  world.login = remains ? await findLogin(world.api) : null;
  world.issues = [];
  world.loadedAt = 0;
  world.linked = new Map();
  world.api.log("logged_out", { still: world.login !== null });
  if (world.login !== null) {
    return {
      prompt: "",
      message:
        "The vault entry “sentry” is one you made yourself, so prifly could not remove it — remove it in prifly's vault to log out fully.",
    };
  }
  return { prompt: "", message: "Logged out. The token is gone from prifly's vault." };
}
