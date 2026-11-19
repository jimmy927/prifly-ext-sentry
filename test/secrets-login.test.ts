import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  findLogin,
  MIGRATED_KEY,
  OLD_ENTRY_HINT,
  removeLogin,
  SECRET_KEY,
  saveLogin,
  takeVaultHint,
  VAULT_ENTRY,
} from "../auth";
import { load } from "../world";
import { fakePrifly } from "./fake-prifly";

const TOKEN = "sntryu_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const OLD = "sntryu_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

const answerWith = (impl: () => Response | Promise<Response>) => {
  globalThis.fetch = (async () => impl()) as unknown as typeof fetch;
};

describe("the manifest", () => {
  test("still names the vault entry, for the migration", async () => {
    const manifest = (await Bun.file(
      join(import.meta.dir, "..", "prifly-extension.json"),
    ).json()) as {
      vault?: string[];
    };
    expect(manifest.vault).toContain(VAULT_ENTRY);
  });
});

describe("logging in", () => {
  test("the token is stored in secrets under token, and the vault is not asked", async () => {
    const fake = fakePrifly("/x");
    expect(await saveLogin(fake.api, TOKEN)).toEqual({ saved: true });
    expect(fake.secrets.get(SECRET_KEY)).toBe(TOKEN);
    expect(fake.filed).toEqual([]);
    expect(fake.entries.size).toBe(0);
  });

  test("a prifly without secrets cannot keep it: says to update, saves nothing", async () => {
    const fake = fakePrifly("/x", { without: ["secrets"] });
    const saved = await saveLogin(fake.api, TOKEN);
    expect(saved.saved).toBe(false);
    expect(JSON.stringify(saved)).toContain("update prifly");
    expect(JSON.stringify(saved)).not.toContain(TOKEN);
    expect(fake.filed).toEqual([]);
  });
});

describe("reading the token", () => {
  test("secrets hold the login, with no name until Sentry is asked", async () => {
    const fake = fakePrifly("/x");
    expect(await findLogin(fake.api)).toBeNull();
    fake.secrets.set(SECRET_KEY, TOKEN);
    expect(await findLogin(fake.api)).toEqual({ token: TOKEN, user: "" });
  });

  test("a secrets store that throws on read is no login, and the log carries no token", async () => {
    const fake = fakePrifly("/x");
    fake.api.secrets = {
      get: async () => {
        throw new Error("sealed store locked");
      },
      set: async () => undefined,
      keys: async () => [],
    };
    expect(await findLogin(fake.api)).toBeNull();
    expect(fake.logs.join("\n")).toContain("secrets_read_failed");
  });

  test("SENTRY_AUTH_TOKEN in the environment is not looked at", async () => {
    const fake = fakePrifly("/x");
    const saved = Bun.env["SENTRY_AUTH_TOKEN"];
    Bun.env["SENTRY_AUTH_TOKEN"] = "from-env";
    try {
      expect(await findLogin(fake.api)).toBeNull();
    } finally {
      if (saved === undefined) delete Bun.env["SENTRY_AUTH_TOKEN"];
      else Bun.env["SENTRY_AUTH_TOKEN"] = saved;
    }
  });
});

describe("logging out", () => {
  test("deletes the secret; no old entry, nothing forgotten", async () => {
    const fake = fakePrifly("/x");
    await saveLogin(fake.api, TOKEN);
    expect(await removeLogin(fake.api)).toBe(false);
    expect(fake.secrets.has(SECRET_KEY)).toBe(false);
    expect(fake.forgotten).toEqual([]);
    expect(await findLogin(fake.api)).toBeNull();
  });

  test("forgets an old vault entry that is still there", async () => {
    const fake = fakePrifly("/x", { secrets: new Map([[MIGRATED_KEY, "1"]]) });
    fake.secrets.set(SECRET_KEY, TOKEN);
    fake.entries.set(VAULT_ENTRY, OLD);
    expect(await removeLogin(fake.api)).toBe(false);
    expect(fake.secrets.has(SECRET_KEY)).toBe(false);
    expect(fake.forgotten).toEqual(["sentry"]);
    expect(fake.entries.size).toBe(0);
  });

  test("an old entry the reader made stays, logout reports it, and it is not migrated back", async () => {
    const fake = fakePrifly("/x", { ownEntry: false });
    fake.secrets.set(SECRET_KEY, TOKEN);
    fake.entries.set(VAULT_ENTRY, OLD);
    expect(await removeLogin(fake.api)).toBe(true);
    expect(await findLogin(fake.api)).toBeNull();
    // A restart over the same secrets and the same leftover entry.
    const again = fakePrifly("/x", { ownEntry: false, secrets: fake.secrets });
    again.entries.set(VAULT_ENTRY, OLD);
    expect(await findLogin(again.api)).toBeNull();
    expect(again.secrets.has(SECRET_KEY)).toBe(false);
  });

  test("a vault that throws on forget does not make logout throw", async () => {
    const fake = fakePrifly("/x");
    fake.secrets.set(SECRET_KEY, TOKEN);
    fake.api.vault = {
      read: async () => OLD,
      forget: async () => {
        throw new Error("vault locked");
      },
    };
    expect(await removeLogin(fake.api)).toBe(true);
    expect(fake.secrets.has(SECRET_KEY)).toBe(false);
    expect(fake.logs.join("\n")).toContain("vault_forget_failed");
    expect(fake.logs.join("\n")).not.toContain(OLD);
  });
});

describe("moving an old vault token into secrets", () => {
  test("copies the token, then forgets the entry", async () => {
    const fake = fakePrifly("/x");
    fake.entries.set(VAULT_ENTRY, TOKEN);
    expect(await findLogin(fake.api)).toEqual({ token: TOKEN, user: "" });
    expect(fake.secrets.get(SECRET_KEY)).toBe(TOKEN);
    expect(fake.forgotten).toEqual(["sentry"]);
    expect(fake.entries.size).toBe(0);
    expect(takeVaultHint(fake.api)).toBe("");
  });

  test("runs once: later reads do not touch the vault again", async () => {
    const fake = fakePrifly("/x");
    fake.entries.set(VAULT_ENTRY, TOKEN);
    await findLogin(fake.api);
    await findLogin(fake.api);
    await findLogin(fake.api);
    expect(fake.forgotten).toEqual(["sentry"]);
  });

  test("does nothing when secrets already hold a token", async () => {
    const fake = fakePrifly("/x");
    fake.secrets.set(SECRET_KEY, TOKEN);
    fake.entries.set(VAULT_ENTRY, OLD);
    expect(await findLogin(fake.api)).toEqual({ token: TOKEN, user: "" });
    expect(fake.secrets.get(SECRET_KEY)).toBe(TOKEN);
    expect(fake.forgotten).toEqual([]);
    expect(fake.entries.get(VAULT_ENTRY)).toBe(OLD);
  });

  test("survives an absent vault", async () => {
    const fake = fakePrifly("/x", { noVault: true });
    expect(await findLogin(fake.api)).toBeNull();
    expect(await saveLogin(fake.api, TOKEN)).toEqual({ saved: true });
    expect(await findLogin(fake.api)).toEqual({ token: TOKEN, user: "" });
    expect(await removeLogin(fake.api)).toBe(false);
    expect(fake.logs).toEqual([]);
  });

  test("survives a vault whose read throws", async () => {
    const fake = fakePrifly("/x");
    fake.api.vault = {
      read: async () => {
        throw new Error("vault locked");
      },
    };
    expect(await findLogin(fake.api)).toBeNull();
    expect(fake.secrets.has(SECRET_KEY)).toBe(false);
  });

  test("an entry the reader made stays; the token is copied and a hint is given once", async () => {
    const fake = fakePrifly("/x", { ownEntry: false });
    fake.entries.set(VAULT_ENTRY, TOKEN);
    expect(await findLogin(fake.api)).toEqual({ token: TOKEN, user: "" });
    expect(fake.secrets.get(SECRET_KEY)).toBe(TOKEN);
    expect(fake.entries.get(VAULT_ENTRY)).toBe(TOKEN);
    expect(takeVaultHint(fake.api)).toBe(OLD_ENTRY_HINT);
    expect(takeVaultHint(fake.api)).toBe("");
    expect(OLD_ENTRY_HINT).not.toContain(TOKEN);
  });
});

describe("the user's name after a restart", () => {
  test("login, then a fresh load shows the same name", async () => {
    const first = fakePrifly("/x");
    expect((await saveLogin(first.api, TOKEN)).saved).toBe(true);
    const second = fakePrifly("/x", { database: first.database, secrets: first.secrets });
    answerWith(() => Response.json({ name: "Ada Lovelace", email: "ada@example.com" }));
    const world = await load(second.api);
    expect(world.login).toEqual({ token: TOKEN, user: "Ada Lovelace" });
  });

  test("Sentry unreachable: the token still works, the name stays empty, and the log has no token", async () => {
    const fake = fakePrifly("/x");
    fake.secrets.set(SECRET_KEY, TOKEN);
    answerWith(() => {
      throw new Error(`connect failed with Bearer ${TOKEN}`);
    });
    const world = await load(fake.api);
    expect(world.login?.token).toBe(TOKEN);
    expect(world.login?.user).toBe("");
    expect(fake.logs.some((line) => line.startsWith("user_name_failed"))).toBe(true);
    expect(fake.logs.join("\n")).toContain("[token]");
    expect(fake.logs.join("\n")).not.toContain(TOKEN);
  });

  test("Sentry answers 401: same, no token in the log", async () => {
    const fake = fakePrifly("/x");
    fake.secrets.set(SECRET_KEY, TOKEN);
    answerWith(() => Response.json({ detail: "bad" }, { status: 401 }));
    const world = await load(fake.api);
    expect(world.login?.user).toBe("");
    expect(fake.logs.join("\n")).not.toContain(TOKEN);
  });
});
