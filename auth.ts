/**
 * The reader's own Sentry login.
 *
 * Sentry has no desktop sign-in flow for a third-party app, so a login here is
 * what `sentry-cli` uses too: a personal auth token the reader makes on
 * Sentry's own page, signed in however they normally are. prifly never sees a
 * password, and the token is theirs — it reaches their organizations and
 * nobody else's, with the scopes they gave it.
 *
 * The token lives in this extension's own `api.secrets`, under the key
 * `token`: stored on login, read each time it is needed, deleted on "Log out".
 * It is never written to a file, and no message or log line here carries it.
 *
 * Earlier versions filed it in prifly's vault as the entry `sentry`. That
 * entry is read once, copied into secrets and forgotten (`migrateVaultToken`);
 * the manifest still names it for that, and for nothing else.
 */

import type { ExtensionApi } from "./prifly-api";

/** The key the token is kept under in `api.secrets`. */
export const SECRET_KEY = "token";

/** The vault entry earlier versions filed the token in; the manifest's `vault` list names it for the migration only. */
export const VAULT_ENTRY = "sentry";

/** Set in secrets once the old vault entry has been looked at, so a later log out is not undone by it. */
export const MIGRATED_KEY = "vault-migrated";

/** The one hint about an old vault entry that this extension could not remove. */
export const OLD_ENTRY_HINT =
  "An old “sentry” entry from an earlier version is still in the Vault dialog; you can remove it there.";

/** The part of the api the login uses; a fake of it is all the tests need. */
export type LoginApi = Pick<ExtensionApi, "secrets" | "vault" | "log">;

/** The token, and Sentry's name for it: `user` is "" until asked. */
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

/** The login in secrets; null when there is none (or secrets cannot be read). */
export async function findLogin(api: LoginApi): Promise<Login | null> {
  const kept = await sentryToken(api);
  return kept === null ? null : { token: kept, user: "" };
}

/**
 * THE one place the reader's Sentry token is read from: everything that calls
 * Sentry (the list, the session tools) gets it here, so where the token is
 * kept changes in this function only. Read each time it is needed, never kept.
 * Null with no login, on a prifly without secrets, or when reading fails.
 */
export async function sentryToken(api: LoginApi): Promise<string | null> {
  if (api.secrets === undefined) return null;
  await migrateVaultToken(api);
  try {
    const token = await api.secrets.get(SECRET_KEY);
    return typeof token === "string" && token !== "" ? token : null;
  } catch (caught) {
    api.log("secrets_read_failed", {
      message: caught instanceof Error ? caught.message : "failed",
    });
    return null;
  }
}

const migrations = new WeakMap<object, Promise<void>>();
const hints = new WeakSet<object>();

/** The hint about an old vault entry that stayed, once; "" after it was taken or when there is none. */
export function takeVaultHint(api: LoginApi): string {
  return hints.delete(api) ? OLD_ENTRY_HINT : "";
}

/**
 * Once per start (and once ever, through a marker in secrets): a token an
 * earlier version filed in the vault is copied into secrets and the vault
 * entry forgotten. Does nothing when secrets already holds a token, when the
 * vault is absent or has no entry, and never throws. `forget` removes only an
 * entry this extension filed; one the reader made stays, and a hint says so.
 */
export function migrateVaultToken(api: LoginApi): Promise<void> {
  const memo = migrations.get(api);
  if (memo !== undefined) return memo;
  const run = migrate(api);
  migrations.set(api, run);
  return run;
}

async function migrate(api: LoginApi): Promise<void> {
  const secrets = api.secrets;
  if (secrets === undefined) return;
  let moving = "";
  try {
    if ((await secrets.get(MIGRATED_KEY)) !== null) return;
    if ((await secrets.get(SECRET_KEY)) === null) {
      const old = await readOld(api);
      if (old !== null) {
        moving = old;
        await secrets.set(SECRET_KEY, old);
        if (!(await forgetOld(api)) && (await readOld(api)) !== null) hints.add(api);
      }
    }
    await secrets.set(MIGRATED_KEY, "1");
  } catch (caught) {
    const message = caught instanceof Error ? caught.message : "failed";
    api.log("vault_migration_failed", {
      message: moving === "" ? message : message.replaceAll(moving, "[token]"),
    });
  }
}

async function readOld(api: LoginApi): Promise<string | null> {
  try {
    const old = await api.vault?.read(VAULT_ENTRY);
    return typeof old === "string" && old !== "" ? old : null;
  } catch {
    return null;
  }
}

/** `forget` on the old entry: true when it removed one; a failure is logged (without a token) and is a no. */
async function forgetOld(api: LoginApi): Promise<boolean> {
  try {
    return (await api.vault?.forget?.(VAULT_ENTRY)) === true;
  } catch (caught) {
    api.log("vault_forget_failed", {
      message: caught instanceof Error ? caught.message : "failed",
    });
    return false;
  }
}

/** How a login the reader just made was kept; `reason` is for the reader, never the token. */
export type SaveResult = { saved: true } | { saved: false; reason: string };

/** Keep a token the reader pasted: in this extension's secrets, nowhere else. */
export async function saveLogin(api: LoginApi, token: string): Promise<SaveResult> {
  if (api.secrets === undefined) {
    return {
      saved: false,
      reason: "This prifly cannot keep secrets: update prifly, then log in again.",
    };
  }
  await migrateVaultToken(api);
  try {
    await api.secrets.set(SECRET_KEY, token);
  } catch (caught) {
    api.log("secrets_write_failed", {
      message: (caught instanceof Error ? caught.message : "failed").replaceAll(token, "[token]"),
    });
    return { saved: false, reason: "prifly could not keep the token, so it was not saved." };
  }
  return { saved: true };
}

/**
 * Log out: delete the secret, and forget an old vault entry this extension
 * filed. True when an old vault entry is still there afterwards — one the
 * reader made themselves, which only they can remove.
 */
export async function removeLogin(api: LoginApi): Promise<boolean> {
  await migrateVaultToken(api);
  try {
    await api.secrets?.set(SECRET_KEY, null);
  } catch (caught) {
    api.log("secrets_delete_failed", {
      message: caught instanceof Error ? caught.message : "failed",
    });
  }
  if ((await readOld(api)) === null) return false;
  await forgetOld(api);
  return (await readOld(api)) !== null;
}

/** Where the reader makes a personal token, on their own Sentry. */
export function tokenPageUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/settings/account/api/auth-tokens/`;
}
