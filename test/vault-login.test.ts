import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  canFileToVault,
  findLogin,
  type LoginApi,
  moveToVault,
  removeLogin,
  saveLogin,
  VAULT_ENTRY,
} from "../auth";
import type { VaultFileRequest, VaultFileResult } from "../prifly-api";

const TOKEN = "sntryu_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const OLD = "sntryu_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const noClirc = { token: "", org: "", url: "" };
const BASE = "https://sentry.io";

type Fake = {
  api: LoginApi;
  /** The vault entry, by name. */
  entries: Map<string, string>;
  asked: { name: string; request: VaultFileRequest }[];
  forgot: string[];
  logs: string[];
  /** The level the reader files at; anything but 1 makes `read` answer null. */
  level: 1 | 2 | 4;
  /** While set, the card stays open until it resolves. */
  gate: Promise<void> | null;
};

/**
 * A prifly with a vault. `answer` is what the reader does on the card;
 * accepting stores the token, as the host would.
 */
function fakeVault(answer: VaultFileResult["outcome"] = "accepted"): Fake {
  const fake: Fake = {
    api: undefined as never,
    entries: new Map(),
    asked: [],
    forgot: [],
    logs: [],
    level: 1,
    gate: null,
  };
  fake.api = {
    features: ["state", "vault-file"],
    log: (event, fields) => {
      fake.logs.push(`${event} ${JSON.stringify(fields ?? {})}`);
    },
    vault: {
      read: async (name) => (fake.level === 1 ? (fake.entries.get(name) ?? null) : null),
      file: async (name, request) => {
        fake.asked.push({ name, request });
        await fake.gate;
        if (answer === "accepted") {
          fake.entries.set(name, request.token);
          return { outcome: "accepted", level: fake.level };
        }
        if (answer === "refused") return { outcome: "refused", message: "no" };
        return { outcome: answer };
      },
      forget: async (name) => {
        fake.forgot.push(name);
        return fake.entries.delete(name);
      },
    },
  };
  return fake;
}

/** A prifly from before the vault features: no `file`, no `forget`, maybe a `read`. */
function oldPrifly(): LoginApi {
  return { log: () => undefined };
}

let folder = "";
beforeEach(async () => {
  folder = await mkdtemp(join(tmpdir(), "sentry-ext-auth-"));
});
afterEach(async () => {
  await rm(folder, { recursive: true, force: true });
});

const hasFile = (name: string) => Bun.file(join(folder, name)).exists();
const writeAuth = (token: string) =>
  Bun.write(join(folder, "auth.json"), JSON.stringify({ token, user: "me" }));

describe("the manifest", () => {
  test("names the vault entry the extension files", async () => {
    const manifest = (await Bun.file(
      join(import.meta.dir, "..", "prifly-extension.json"),
    ).json()) as {
      vault?: string[];
    };
    expect(manifest.vault).toContain(VAULT_ENTRY);
  });
});

describe("logging in", () => {
  test("with vault-file, the token is filed in the vault and no auth.json is written", async () => {
    const fake = fakeVault();
    const saved = await saveLogin(fake.api, folder, TOKEN, "me", BASE);
    expect(saved).toEqual({ saved: true, source: "prifly vault" });
    expect(fake.entries.get("sentry")).toBe(TOKEN);
    expect(fake.asked[0]?.request.host).toBe("sentry.io");
    expect(await hasFile("auth.json")).toBe(false);
  });

  test("a vault login deletes an auth.json left from before", async () => {
    await writeAuth(OLD);
    const fake = fakeVault();
    await saveLogin(fake.api, folder, TOKEN, "me", BASE);
    expect(await hasFile("auth.json")).toBe(false);
  });

  test("declined on the card: nothing saved, no auth.json, and the reason does not carry the token", async () => {
    const fake = fakeVault("declined");
    const saved = await saveLogin(fake.api, folder, TOKEN, "me", BASE);
    expect(saved.saved).toBe(false);
    expect(JSON.stringify(saved)).not.toContain(TOKEN);
    expect(await hasFile("auth.json")).toBe(false);
    expect(fake.entries.size).toBe(0);
  });

  test("on an older prifly the token goes to auth.json as before", async () => {
    const saved = await saveLogin(oldPrifly(), folder, TOKEN, "me", BASE);
    expect(saved).toEqual({ saved: true, source: "auth.json" });
    expect(await Bun.file(join(folder, "auth.json")).json()).toEqual({ token: TOKEN, user: "me" });
  });

  test("a prifly with a vault but without vault-file keeps using auth.json", async () => {
    const api: LoginApi = {
      features: ["state"],
      log: () => undefined,
      vault: { read: async () => null },
    };
    expect(canFileToVault(api)).toBe(false);
    const saved = await saveLogin(api, folder, TOKEN, "me", BASE);
    expect(saved).toEqual({ saved: true, source: "auth.json" });
  });
});

describe("reading the token", () => {
  test("the vault comes first, then auth.json, then SENTRY_AUTH_TOKEN, then ~/.sentryclirc", async () => {
    const fake = fakeVault();
    const env = { SENTRY_AUTH_TOKEN: "from-env" };
    const clirc = { token: "from-clirc", org: "", url: "" };
    fake.entries.set("sentry", TOKEN);
    await writeAuth(OLD);

    expect(await findLogin(folder, env, clirc, fake.api)).toEqual({
      token: TOKEN,
      user: "",
      source: "prifly vault",
    });
    fake.entries.clear();
    expect((await findLogin(folder, env, clirc, fake.api))?.source).toBe("auth.json");
    await rm(join(folder, "auth.json"));
    expect((await findLogin(folder, env, clirc, fake.api))?.source).toBe("SENTRY_AUTH_TOKEN");
    expect((await findLogin(folder, {}, clirc, fake.api))?.source).toBe("~/.sentryclirc");
    expect(await findLogin(folder, {}, noClirc, fake.api)).toBeNull();
  });

  test("on an older prifly auth.json is read", async () => {
    await writeAuth(OLD);
    const login = await findLogin(folder, {}, noClirc, oldPrifly());
    expect(login).toEqual({ token: OLD, user: "me", source: "auth.json" });
  });

  test("a vault that throws on read falls back without logging the token", async () => {
    const fake = fakeVault();
    fake.api.vault = {
      read: async () => {
        throw new Error("vault locked");
      },
    };
    await writeAuth(OLD);
    const login = await findLogin(folder, {}, noClirc, fake.api);
    expect(login?.source).toBe("auth.json");
    expect(fake.logs.join("\n")).not.toContain(OLD);
  });
});

describe("the one-time move to the vault", () => {
  test("accepted: the token is filed and auth.json is deleted", async () => {
    const fake = fakeVault("accepted");
    await writeAuth(OLD);
    expect(await moveToVault(fake.api, folder, BASE)).toBe("moved");
    expect(fake.entries.get("sentry")).toBe(OLD);
    expect(await hasFile("auth.json")).toBe(false);
    expect((await findLogin(folder, {}, noClirc, fake.api))?.source).toBe("prifly vault");
  });

  test("declined: auth.json is kept and still used, and the next start does not ask again", async () => {
    const fake = fakeVault("declined");
    await writeAuth(OLD);
    expect(await moveToVault(fake.api, folder, BASE)).toBe("declined");
    expect(await hasFile("auth.json")).toBe(true);
    expect((await findLogin(folder, {}, noClirc, fake.api))?.token).toBe(OLD);

    expect(await moveToVault(fake.api, folder, BASE)).toBe("already declined");
    expect(fake.asked).toHaveLength(1);
  });

  test("asked again after the reader logs in again", async () => {
    const fake = fakeVault("declined");
    await writeAuth(OLD);
    await moveToVault(fake.api, folder, BASE);

    // A fresh login on an older prifly (auth.json again), then the upgrade.
    await saveLogin(oldPrifly(), folder, TOKEN, "me", BASE);
    expect(await moveToVault(fake.api, folder, BASE)).toBe("declined");
    expect(fake.asked).toHaveLength(2);
    expect(fake.asked[1]?.request.token).toBe(TOKEN);
  });

  test("a card nobody answered is asked again at the next start", async () => {
    const fake = fakeVault("timed out");
    await writeAuth(OLD);
    expect(await moveToVault(fake.api, folder, BASE)).toBe("unanswered");
    expect(await moveToVault(fake.api, folder, BASE)).toBe("unanswered");
    expect(fake.asked).toHaveLength(2);
    expect(await hasFile("auth.json")).toBe(true);
  });

  test("nothing is asked without an auth.json, with an entry already there, or on an older prifly", async () => {
    const fake = fakeVault();
    expect(await moveToVault(fake.api, folder, BASE)).toBe("nothing to move");
    await writeAuth(OLD);
    fake.entries.set("sentry", TOKEN);
    expect(await moveToVault(fake.api, folder, BASE)).toBe("vault has one");
    expect(await moveToVault(oldPrifly(), folder, BASE)).toBe("unavailable");
    expect(fake.asked).toHaveLength(0);
    expect(await hasFile("auth.json")).toBe(true);
  });

  test("the token is in no log line", async () => {
    const fake = fakeVault("declined");
    await writeAuth(OLD);
    await moveToVault(fake.api, folder, BASE);
    expect(fake.logs.join("\n")).not.toContain(OLD);
  });
});

describe("logging out", () => {
  test("forgets the vault entry and deletes auth.json", async () => {
    const fake = fakeVault();
    await saveLogin(fake.api, folder, TOKEN, "me", BASE);
    await writeAuth(OLD);
    await removeLogin(fake.api, folder);
    expect(fake.forgot).toEqual(["sentry"]);
    expect(fake.entries.size).toBe(0);
    expect(await hasFile("auth.json")).toBe(false);
    expect(await findLogin(folder, {}, noClirc, fake.api)).toBeNull();
  });

  test("on an older prifly it only deletes auth.json", async () => {
    await writeAuth(OLD);
    await removeLogin(oldPrifly(), folder);
    expect(await hasFile("auth.json")).toBe(false);
  });

  test("a logout clears the declined marker, so a later auth.json would be offered", async () => {
    const fake = fakeVault("declined");
    await writeAuth(OLD);
    await moveToVault(fake.api, folder, BASE);
    await removeLogin(fake.api, folder);
    await writeAuth(TOKEN);
    expect(await moveToVault(fake.api, folder, BASE)).toBe("declined");
    expect(fake.asked).toHaveLength(2);
  });
});

describe("a level the extension cannot read", () => {
  test("login accepted at level 2 is not reported as logged in, and the entry is forgotten", async () => {
    const fake = fakeVault();
    fake.level = 2;
    const saved = await saveLogin(fake.api, folder, TOKEN, "me", BASE);
    expect(saved.saved).toBe(false);
    expect(fake.forgot).toEqual(["sentry"]);
    expect(await hasFile("auth.json")).toBe(false);
  });

  test("a move accepted at level 4 keeps auth.json, which stays the login, and is not asked again", async () => {
    const fake = fakeVault();
    fake.level = 4;
    await writeAuth(OLD);
    expect(await moveToVault(fake.api, folder, BASE)).toBe("unreadable level");
    expect(await hasFile("auth.json")).toBe(true);
    expect((await findLogin(folder, {}, noClirc, fake.api))?.token).toBe(OLD);
    expect(await moveToVault(fake.api, folder, BASE)).toBe("already declined");
  });
});

describe("a card left open while the reader logs in or out", () => {
  function hold(fake: Fake): () => void {
    let release = () => {};
    fake.gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    return release;
  }

  test("logout during a pending move: the late accept is taken back and nothing is logged in", async () => {
    const fake = fakeVault();
    const release = hold(fake);
    await writeAuth(OLD);
    const moving = moveToVault(fake.api, folder, BASE);
    await Bun.sleep(5);
    await removeLogin(fake.api, folder);
    release();
    expect(await moving).toBe("superseded");
    expect(fake.entries.size).toBe(0);
    expect(await hasFile("auth.json")).toBe(false);
    expect(await findLogin(folder, {}, noClirc, fake.api)).toBeNull();
  });

  test("login during a pending move is refused until the card is answered", async () => {
    const fake = fakeVault();
    const release = hold(fake);
    await writeAuth(OLD);
    const moving = moveToVault(fake.api, folder, BASE);
    await Bun.sleep(5);
    const saved = await saveLogin(fake.api, folder, TOKEN, "me", BASE);
    expect(saved.saved).toBe(false);
    expect(fake.asked).toHaveLength(1);
    release();
    expect(await moving).toBe("moved");
    expect(fake.entries.get("sentry")).toBe(OLD);
  });

  test("logout while the login card is open: the late accept is taken back", async () => {
    const fake = fakeVault();
    const release = hold(fake);
    const saving = saveLogin(fake.api, folder, TOKEN, "me", BASE);
    await Bun.sleep(5);
    await removeLogin(fake.api, folder);
    release();
    expect((await saving).saved).toBe(false);
    expect(fake.entries.size).toBe(0);
  });

  test("a vault that throws on forget does not stop logout from deleting auth.json", async () => {
    const fake = fakeVault();
    await writeAuth(OLD);
    fake.api.vault = {
      read: async () => null,
      file: async () => ({ outcome: "declined" }),
      forget: async () => {
        throw new Error("vault locked");
      },
    };
    await removeLogin(fake.api, folder);
    expect(await hasFile("auth.json")).toBe(false);
  });
});
