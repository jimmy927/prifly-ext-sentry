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
 * 1. prifly's vault, the entry `sentry` (`api.vault.read`) — where a token
 *    pasted into the chooser's login row is filed on a prifly with
 *    "vault-file", so it moves with prifly's data. Gone again on "Log out".
 * 2. `auth.json` next to this file — where that token is kept on an older
 *    prifly, readable only by the user who owns it. On a newer one it is only
 *    a leftover: moved into the vault on the first start (the reader confirms
 *    on prifly's vault card) and deleted; kept, and still used, while the
 *    reader has declined (or filed it at a level this extension cannot read),
 *    when the move is never offered again. Logging in again files the new
 *    token in the vault and deletes it.
 * 3. `SENTRY_AUTH_TOKEN` in the host's environment — sentry-cli's variable.
 * 4. `~/.sentryclirc`'s `[auth] token` — what `sentry-cli login` writes.
 *
 * The last two belong to sentry-cli, so this extension reads them and never
 * writes or deletes them. No message or log line here carries a token.
 */

import { chmod } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionApi } from "./prifly-api";

export type LoginSource = "prifly vault" | "auth.json" | "SENTRY_AUTH_TOKEN" | "~/.sentryclirc";

/** The vault entry's name; the manifest's `vault` list names it too. */
export const VAULT_ENTRY = "sentry";

/** The part of the api the login uses; a fake of it is all the tests need. */
export type LoginApi = Pick<ExtensionApi, "features" | "vault" | "log">;

/** Whether this prifly files and forgets logins in its vault ("vault-file"). */
export function canFileToVault(api: LoginApi): boolean {
  return (
    api.features?.includes("vault-file") === true &&
    typeof api.vault?.file === "function" &&
    typeof api.vault.forget === "function"
  );
}

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
  api?: LoginApi,
): Promise<Login | null> {
  const filed = await readVault(api);
  if (filed !== null) return { token: filed, user: "", source: "prifly vault" };
  const saved = await readSaved(folder);
  if (saved !== null) return { ...saved, source: "auth.json" };
  const fromEnv = env["SENTRY_AUTH_TOKEN"] ?? "";
  if (fromEnv !== "") return { token: fromEnv, user: "", source: "SENTRY_AUTH_TOKEN" };
  if (clirc.token !== "") return { token: clirc.token, user: "", source: "~/.sentryclirc" };
  return null;
}

/** The vault entry's token; null on a prifly without a vault, with no entry, or when reading fails. */
async function readVault(api: LoginApi | undefined): Promise<string | null> {
  if (typeof api?.vault?.read !== "function") return null;
  try {
    const token = await api.vault.read(VAULT_ENTRY);
    return typeof token === "string" && token !== "" ? token : null;
  } catch (caught) {
    api.log("vault_read_failed", { message: caught instanceof Error ? caught.message : "failed" });
    return null;
  }
}

/** What `auth.json` holds, or null when it is missing, unreadable or has no token. */
async function readSaved(folder: string): Promise<{ token: string; user: string } | null> {
  const saved = (await Bun.file(join(folder, "auth.json"))
    .json()
    .catch(() => null)) as { token?: unknown; user?: unknown } | null;
  if (typeof saved?.token !== "string" || saved.token === "") return null;
  return { token: saved.token, user: typeof saved.user === "string" ? saved.user : "you" };
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

/**
 * Marks that the reader declined prifly's vault card for the token in
 * `auth.json`, so the move is never asked again. Next to `auth.json`, and
 * deleted with it: when a new login is filed in the vault, and on "Log out".
 */
const DECLINED = "vault-declined";

async function markDeclined(folder: string): Promise<void> {
  await Bun.write(join(folder, DECLINED), "");
}

async function clearDeclined(folder: string): Promise<void> {
  await Bun.file(join(folder, DECLINED))
    .delete()
    .catch(() => undefined);
}

async function wasDeclined(folder: string): Promise<boolean> {
  return await Bun.file(join(folder, DECLINED)).exists();
}

function hostOf(baseUrl: string): string | undefined {
  try {
    return new URL(baseUrl).host || undefined;
  } catch {
    return undefined;
  }
}

function labelOf(user: string): string {
  return user === "" || user === "you" ? "Sentry" : `Sentry, ${user}`;
}

/** How a login the reader just made was kept; `reason` is for the reader, never the token. */
export type SaveResult =
  | { saved: true; source: "prifly vault" | "auth.json" }
  | { saved: false; reason: string };

/**
 * Keep a token the reader pasted. With "vault-file" it is filed in prifly's
 * vault (the reader confirms on the card) and no `auth.json` is written — one
 * left from before is deleted; on an older prifly it goes to `auth.json` as it
 * always did. A login clears the "declined" marker, because the reader is
 * asking for it again; declining this card sets it again.
 */
export async function saveLogin(
  api: LoginApi,
  folder: string,
  token: string,
  user: string,
  baseUrl: string,
): Promise<SaveResult> {
  if (!canFileToVault(api)) {
    await writeLogin(folder, token, user);
    await clearDeclined(folder);
    generation += 1;
    return { saved: true, source: "auth.json" };
  }
  if (cardOpen) {
    return { saved: false, reason: "Answer prifly's vault card first, then log in again." };
  }
  const before = generation;
  const answer = await ask(() =>
    api.vault?.file?.(VAULT_ENTRY, {
      token,
      label: labelOf(user),
      host: hostOf(baseUrl),
      why: "Your Sentry issues in prifly: the token you just pasted into the Sentry chooser",
    }),
  );
  if (answer?.outcome === "accepted") {
    if (generation !== before) {
      // Logged out while the card was open: the reader's last word was "out".
      await forgetQuietly(api);
      return { saved: false, reason: "You logged out while the vault card was open." };
    }
    if ((await readVault(api)) === null) {
      // Filed at level 2 or 4, which an extension cannot read: it would be logged out at the next start.
      await forgetQuietly(api);
      return {
        saved: false,
        reason:
          "The token was filed at a level this extension cannot read. Log in again and keep it at level 1.",
      };
    }
    generation += 1;
    await forgetLogin(folder);
    await clearDeclined(folder);
    return { saved: true, source: "prifly vault" };
  }
  if (answer?.outcome === "declined") {
    await markDeclined(folder);
    return {
      saved: false,
      reason: "You declined to keep the token in prifly's vault, so it was not saved.",
    };
  }
  if (answer?.outcome === "refused") {
    return { saved: false, reason: `prifly's vault refused the token: ${answer.message}` };
  }
  return { saved: false, reason: "The vault card was not answered, so the token was not saved." };
}

/** Log out: forget the vault entry this extension filed, and delete `auth.json`. */
export async function removeLogin(api: LoginApi, folder: string): Promise<void> {
  generation += 1;
  await forgetLogin(folder);
  await clearDeclined(folder);
  if (canFileToVault(api)) await forgetQuietly(api);
}

/** Counts logins and logouts, so a card answered after one knows it is out of date. */
let generation = 0;
/** Whether a vault card of ours is waiting for the reader. */
let cardOpen = false;

async function ask<T>(show: () => Promise<T> | undefined): Promise<T | undefined> {
  cardOpen = true;
  try {
    return await show();
  } finally {
    cardOpen = false;
  }
}

/** `forget`, with a failure said in the log (without a token) rather than thrown. */
async function forgetQuietly(api: LoginApi): Promise<void> {
  try {
    await api.vault?.forget?.(VAULT_ENTRY);
  } catch (caught) {
    api.log("vault_forget_failed", {
      message: caught instanceof Error ? caught.message : "failed",
    });
  }
}

/** What `moveToVault` did, for the log. */
export type MoveOutcome =
  | "moved"
  | "declined"
  | "unanswered"
  | "unavailable"
  | "nothing to move"
  | "already declined"
  | "vault has one"
  | "unreadable level"
  | "superseded";

/**
 * The one-time move: on a prifly with "vault-file", a token in `auth.json`
 * with no vault entry yet is filed in the vault (the reader confirms on the
 * card, which can take as long as they like), and `auth.json` is deleted once
 * they accept. Declined (or filed at a level this extension cannot
 * read), `auth.json` stays in use and the move is never offered again; logging
 * in again files the new token in the vault instead. A card that went unanswered or was refused is
 * asked again at the next start.
 */
export async function moveToVault(
  api: LoginApi,
  folder: string,
  baseUrl: string,
): Promise<MoveOutcome> {
  if (!canFileToVault(api)) return "unavailable";
  const saved = await readSaved(folder);
  if (saved === null) return "nothing to move";
  if (await wasDeclined(folder)) return "already declined";
  if ((await readVault(api)) !== null) return "vault has one";
  if (cardOpen) return "unanswered";
  const before = generation;
  const answer = await ask(() =>
    api.vault?.file?.(VAULT_ENTRY, {
      token: saved.token,
      label: labelOf(saved.user),
      host: hostOf(baseUrl),
      why: "Moves the Sentry token from auth.json in the extension's folder into the vault, so it travels with prifly's data",
    }),
  );
  if (answer?.outcome === "accepted") {
    if (generation !== before) {
      // Logged out (or in) while the card was open: that is the newer word.
      await forgetQuietly(api);
      return "superseded";
    }
    if ((await readVault(api)) === null) {
      // Filed at level 2 or 4: unreadable here, so auth.json stays the login.
      await markDeclined(folder);
      return "unreadable level";
    }
    await forgetLogin(folder);
    return "moved";
  }
  if (answer?.outcome === "declined") {
    await markDeclined(folder);
    return "declined";
  }
  return "unanswered";
}

/** Where the reader makes a personal token, on their own Sentry. */
export function tokenPageUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/settings/account/api/auth-tokens/`;
}
