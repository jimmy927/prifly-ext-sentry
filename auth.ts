/**
 * The reader's own Sentry login.
 *
 * Sentry has no desktop sign-in flow for a third-party app, so a login here is
 * what `sentry-cli` uses too: a personal auth token the reader makes on
 * Sentry's own page, signed in however they normally are. prifly never sees a
 * password, and the token is theirs — it reaches their organizations and
 * nobody else's, with the scopes they gave it.
 *
 * Found, in this order:
 *
 * 1. `auth.json` next to this file — pasted into the chooser's login row,
 *    readable only by the user who owns it, gone again on "Log out".
 * 2. `SENTRY_AUTH_TOKEN` in the host's environment — sentry-cli's variable.
 * 3. `~/.sentryclirc`'s `[auth] token` — what `sentry-cli login` writes.
 *
 * The last two belong to sentry-cli, so this extension reads them and never
 * writes or deletes them.
 */

import { chmod } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export type LoginSource = "auth.json" | "SENTRY_AUTH_TOKEN" | "~/.sentryclirc";

export type Login = { token: string; user: string; source: LoginSource };

/** What `~/.sentryclirc` says: its token, default organization and server. */
export type Clirc = { token: string; org: string; url: string };

/**
 * sentry-cli's INI file. Only three keys matter here: `[auth] token`,
 * `[defaults] org` and `[defaults] url`.
 */
export function parseClirc(text: string): Clirc {
  const values = iniValues(text);
  return {
    token: values.get("auth.token") ?? "",
    org: values.get("defaults.org") ?? "",
    url: values.get("defaults.url") ?? "",
  };
}

/** Every `key = value` of an INI file, as `section.key`, lower-cased names, unquoted values. */
function iniValues(text: string): Map<string, string> {
  const values = new Map<string, string>();
  let section = "";
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    const header = /^\[([^\]]+)]$/.exec(line);
    if (header !== null) {
      section = (header[1] ?? "").trim().toLowerCase();
      continue;
    }
    const eq = line.indexOf("=");
    if (eq < 1 || line.startsWith("#") || line.startsWith(";")) continue;
    const key = line.slice(0, eq).trim().toLowerCase();
    values.set(
      `${section}.${key}`,
      line
        .slice(eq + 1)
        .trim()
        .replace(/^["']|["']$/g, ""),
    );
  }
  return values;
}

export async function readClirc(home = homedir()): Promise<Clirc> {
  const text = await Bun.file(join(home, ".sentryclirc"))
    .text()
    .catch(() => "");
  return parseClirc(text);
}

/**
 * A Sentry token is one unbroken word: `sntryu_…` (personal), `sntrys_…`
 * (organization), or the 64 hex characters of an older one. It is checked
 * against Sentry before it is kept; this only catches a paste that brought a
 * sentence or the page's URL along with it.
 */
export function looksLikeToken(text: string): boolean {
  const token = text.trim();
  return /^sntry[a-z]?_[A-Za-z0-9_+/=-]{20,}$/.test(token) || /^[0-9a-f]{64}$/i.test(token);
}

/** The login, wherever the reader keeps one; null when there is none anywhere. */
export async function findLogin(
  folder: string,
  env: Record<string, string | undefined>,
  clirc: Clirc,
): Promise<Login | null> {
  const saved = (await Bun.file(join(folder, "auth.json"))
    .json()
    .catch(() => null)) as { token?: unknown; user?: unknown } | null;
  if (typeof saved?.token === "string" && saved.token !== "") {
    return {
      token: saved.token,
      user: typeof saved.user === "string" ? saved.user : "you",
      source: "auth.json",
    };
  }
  const fromEnv = env["SENTRY_AUTH_TOKEN"] ?? "";
  if (fromEnv !== "") return { token: fromEnv, user: "", source: "SENTRY_AUTH_TOKEN" };
  if (clirc.token !== "") return { token: clirc.token, user: "", source: "~/.sentryclirc" };
  return null;
}

export async function writeLogin(folder: string, token: string, user: string): Promise<void> {
  const path = join(folder, "auth.json");
  await Bun.write(path, JSON.stringify({ token, user }, null, 2));
  // Someone's account, on a machine that may have other users on it.
  await chmod(path, 0o600);
}

export async function forgetLogin(folder: string): Promise<void> {
  await Bun.file(join(folder, "auth.json"))
    .delete()
    .catch(() => undefined);
}

/** Where the reader makes a personal token, on their own Sentry. */
export function tokenPageUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/settings/account/api/auth-tokens/`;
}
