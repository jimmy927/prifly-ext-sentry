import { afterEach, describe, expect, test } from "bun:test";
import { saveLogin } from "../auth";
import { load } from "../world";
import { fakePrifly } from "./fake-prifly";

const TOKEN = "sntryu_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

const answerWith = (impl: () => Response | Promise<Response>) => {
  globalThis.fetch = (async () => impl()) as unknown as typeof fetch;
};

describe("the user's name after a restart", () => {
  test("login via the vault, then a fresh load shows the same name", async () => {
    const first = fakePrifly("/x");
    expect((await saveLogin(first.api, TOKEN, "Ada Lovelace", "https://sentry.io")).saved).toBe(
      true,
    );
    // A restart: a new api over the same vault and database.
    const second = fakePrifly("/x", { database: first.database });
    for (const [name, token] of first.entries) second.entries.set(name, token);
    answerWith(() => Response.json({ name: "Ada Lovelace", email: "ada@example.com" }));
    const world = await load(second.api);
    expect(world.login).toEqual({ token: TOKEN, user: "Ada Lovelace" });
  });

  test("Sentry unreachable: the token still works, the name stays empty, and the log has no token", async () => {
    const fake = fakePrifly("/x");
    fake.entries.set("sentry", TOKEN);
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
    fake.entries.set("sentry", TOKEN);
    answerWith(() => Response.json({ detail: "bad" }, { status: 401 }));
    const world = await load(fake.api);
    expect(world.login?.user).toBe("");
    expect(fake.logs.join("\n")).not.toContain(TOKEN);
  });
});
