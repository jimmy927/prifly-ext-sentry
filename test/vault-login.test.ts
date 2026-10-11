import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { findLogin, removeLogin, saveLogin, VAULT_ENTRY } from "../auth";
import { type FakePrifly, fakePrifly } from "./fake-prifly";

const TOKEN = "sntryu_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const OLD = "sntryu_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const BASE = "https://sentry.io";

/** A held-open vault card: the answer comes when the returned function is called. */
function hold(fake: FakePrifly): () => void {
  let release = () => {};
  fake.control.gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  return release;
}

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
  test("the token is filed in the vault entry sentry, for the host of the address", async () => {
    const fake = fakePrifly("/x");
    expect(await saveLogin(fake.api, TOKEN, "me", BASE)).toEqual({ saved: true });
    expect(fake.entries.get("sentry")).toBe(TOKEN);
    expect(fake.filed[0]?.request.host).toBe("sentry.io");
    expect(fake.filed[0]?.request.label).toBe("Sentry, me");
  });

  test("declined on the card: nothing saved, and the reason does not carry the token", async () => {
    const fake = fakePrifly("/x", { answer: "declined" });
    const saved = await saveLogin(fake.api, TOKEN, "me", BASE);
    expect(saved.saved).toBe(false);
    expect(JSON.stringify(saved)).not.toContain(TOKEN);
    expect(fake.entries.size).toBe(0);
  });

  test("refused or unanswered: nothing saved, each says why", async () => {
    const refused = await saveLogin(fakePrifly("/x", { answer: "refused" }).api, TOKEN, "me", BASE);
    expect(refused).toEqual({
      saved: false,
      reason: "prifly's vault refused the token: not listed",
    });
    const silent = await saveLogin(
      fakePrifly("/x", { answer: "timed out" }).api,
      TOKEN,
      "me",
      BASE,
    );
    expect(silent.saved).toBe(false);
  });
});

describe("reading the token", () => {
  test("the vault entry is the login, with no name until Sentry is asked", async () => {
    const fake = fakePrifly("/x");
    expect(await findLogin(fake.api)).toBeNull();
    fake.entries.set("sentry", TOKEN);
    expect(await findLogin(fake.api)).toEqual({ token: TOKEN, user: "" });
  });

  test("a vault that throws on read is no login, and the log does not carry a token", async () => {
    const fake = fakePrifly("/x");
    fake.entries.set("sentry", OLD);
    fake.api.vault = {
      read: async () => {
        throw new Error("vault locked");
      },
    };
    expect(await findLogin(fake.api)).toBeNull();
    expect(fake.logs.join("\n")).toContain("vault_read_failed");
    expect(fake.logs.join("\n")).not.toContain(OLD);
  });

  test("the environment, a clirc and a file in the folder are not looked at", async () => {
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
  test("forgets the vault entry", async () => {
    const fake = fakePrifly("/x");
    await saveLogin(fake.api, TOKEN, "me", BASE);
    expect(await removeLogin(fake.api)).toBe(false);
    expect(fake.forgotten).toEqual(["sentry"]);
    expect(fake.entries.size).toBe(0);
    expect(await findLogin(fake.api)).toBeNull();
  });

  test("an entry the reader made themselves stays, and logout says so", async () => {
    const fake = fakePrifly("/x", { ownEntry: false });
    fake.entries.set("sentry", TOKEN);
    expect(await removeLogin(fake.api)).toBe(true);
    expect(await findLogin(fake.api)).toEqual({ token: TOKEN, user: "" });
  });

  test("a vault that throws on forget does not make logout throw", async () => {
    const fake = fakePrifly("/x");
    fake.api.vault = {
      read: async () => null,
      file: async () => ({ outcome: "declined" }),
      forget: async () => {
        throw new Error("vault locked");
      },
    };
    expect(await removeLogin(fake.api)).toBe(false);
    expect(fake.logs.join("\n")).toContain("vault_forget_failed");
  });
});

describe("a level the extension cannot read", () => {
  test("login accepted at level 2 is not reported as logged in, and the entry is forgotten", async () => {
    const fake = fakePrifly("/x");
    fake.control.level = 2;
    const saved = await saveLogin(fake.api, TOKEN, "me", BASE);
    expect(saved.saved).toBe(false);
    expect(fake.forgotten).toEqual(["sentry"]);
  });
});

describe("a card left open while the reader logs in or out", () => {
  test("login while a card is open is refused until it is answered", async () => {
    const fake = fakePrifly("/x");
    const release = hold(fake);
    const first = saveLogin(fake.api, TOKEN, "me", BASE);
    await Bun.sleep(5);
    const second = await saveLogin(fake.api, OLD, "me", BASE);
    expect(second.saved).toBe(false);
    expect(fake.filed).toHaveLength(1);
    release();
    expect(await first).toEqual({ saved: true });
    expect(fake.entries.get("sentry")).toBe(TOKEN);
  });

  test("logout while the login card is open: the late accept is taken back", async () => {
    const fake = fakePrifly("/x");
    const release = hold(fake);
    const saving = saveLogin(fake.api, TOKEN, "me", BASE);
    await Bun.sleep(5);
    await removeLogin(fake.api);
    release();
    expect((await saving).saved).toBe(false);
    expect(fake.entries.size).toBe(0);
  });
});
