/**
 * The reader's own Sentry login.
 *
 * Sentry has no desktop sign-in flow for a third-party app, so a login here is
 * what `sentry-cli` uses too: a personal auth token the reader makes on
 * Sentry's own page, signed in however they normally are. prifly never sees a
 * password, and the token is theirs — it reaches their organizations and
 * nobody else's, with the scopes they gave it.
 *
 * The token lives only in prifly's vault, as the entry `sentry`: filed with
 * `api.vault.file` (the reader confirms on a card), read with
 * `api.vault.read`, removed on "Log out" with `api.vault.forget`. It is never
 * written to a file, and no message or log line here carries it.
 */

import type { ExtensionApi } from "./prifly-api";

/** The vault entry's name; the manifest's `vault` list names it too. */
export const VAULT_ENTRY = "sentry";

/** The part of the api the login uses; a fake of it is all the tests need. */
export type LoginApi = Pick<ExtensionApi, "vault" | "log">;

/** The vault holds only the token; `user` is Sentry's name for it, "" until asked. */
export type Login = { token: string; user: string };

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

/** The login in the vault; null when there is none (or the vault cannot be read). */
export async function findLogin(api: LoginApi): Promise<Login | null> {
  const filed = await readVault(api);
  return filed === null ? null : { token: filed, user: "" };
}

/** The vault entry's token; null with no entry, above level 1, or when reading fails. */
async function readVault(api: LoginApi): Promise<string | null> {
  try {
    const token = await api.vault?.read(VAULT_ENTRY);
    return typeof token === "string" && token !== "" ? token : null;
  } catch (caught) {
    api.log("vault_read_failed", { message: caught instanceof Error ? caught.message : "failed" });
    return null;
  }
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
export type SaveResult = { saved: true } | { saved: false; reason: string };

/**
 * Keep a token the reader pasted: filed in prifly's vault (the reader confirms
 * on the card), nowhere else.
 */
export async function saveLogin(
  api: LoginApi,
  token: string,
  user: string,
  baseUrl: string,
): Promise<SaveResult> {
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
    return { saved: true };
  }
  if (answer?.outcome === "declined") {
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

/**
 * Log out: forget the vault entry this extension filed. True when the vault
 * still reads a token afterwards — an entry the reader made themselves, which
 * only they can remove.
 */
export async function removeLogin(api: LoginApi): Promise<boolean> {
  generation += 1;
  await forgetQuietly(api);
  return (await readVault(api)) !== null;
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

/** Where the reader makes a personal token, on their own Sentry. */
export function tokenPageUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/settings/account/api/auth-tokens/`;
}
