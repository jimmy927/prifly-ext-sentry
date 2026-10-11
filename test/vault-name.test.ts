import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveLogin } from "../auth";
import type { ExtensionApi } from "../prifly-api";
import { load } from "../world";

const TOKEN = "sntryu_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const realFetch = globalThis.fetch;
let folder = "";
let logs: string[] = [];
let entries: Map<string, string>;

beforeEach(async () => {
  folder = await mkdtemp(join(tmpdir(), "sentry-ext-name-"));
  logs = [];
  entries = new Map();
});
afterEach(async () => {
  globalThis.fetch = realFetch;
  await rm(folder, { recursive: true, force: true });
});

/** A prifly with a vault that outlives a "restart": the entries map is shared. */
function prifly(): ExtensionApi {
  return {
    folder,
    features: ["vault-file"],
    log: (event: string, fields?: Record<string, unknown>) => {
      logs.push(`${event} ${JSON.stringify(fields ?? {})}`);
    },
    sessions: () => [],
    vault: {
      read: async (name: string) => entries.get(name) ?? null,
      file: async (name: string, request: { token: string }) => {
        entries.set(name, request.token);
        return { outcome: "accepted", level: 1 };
      },
      forget: async (name: string) => entries.delete(name),
    },
  } as unknown as ExtensionApi;
}

const answerWith = (impl: () => Response | Promise<Response>) => {
  globalThis.fetch = (async () => impl()) as unknown as typeof fetch;
};

describe("the user's name after a restart", () => {
  test("login via the vault, then a fresh load shows the same name", async () => {
    const first = prifly();
    expect((await saveLogin(first, folder, TOKEN, "Ada Lovelace", "https://sentry.io")).saved).toBe(
      true,
    );
    answerWith(() => Response.json({ name: "Ada Lovelace", email: "ada@example.com" }));
    const world = await load(prifly());
    expect(world.login?.source).toBe("prifly vault");
    expect(world.login?.user).toBe("Ada Lovelace");
  });

  test("Sentry unreachable: the token still works, the name stays empty, and the log has no token", async () => {
    entries.set("sentry", TOKEN);
    answerWith(() => {
      throw new Error(`connect failed with Bearer ${"x"}`);
    });
    const world = await load(prifly());
    expect(world.login?.token).toBe(TOKEN);
    expect(world.login?.user).toBe("");
    expect(logs.some((line) => line.startsWith("user_name_failed"))).toBe(true);
    expect(logs.join("\n")).not.toContain(TOKEN);
  });

  test("Sentry answers 401: same, no token in the log", async () => {
    entries.set("sentry", TOKEN);
    answerWith(() => Response.json({ detail: "bad" }, { status: 401 }));
    const world = await load(prifly());
    expect(world.login?.user).toBe("");
    expect(logs.join("\n")).not.toContain(TOKEN);
  });
});
