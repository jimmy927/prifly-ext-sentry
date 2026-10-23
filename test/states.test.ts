import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { activate, choices, launch } from "../index";
import type { LaunchBoard, LaunchChoice } from "../prifly-api";
import { SETTING_DEFAULTS } from "../settings";
import { type FakePrifly, fakePrifly, type Needed } from "./fake-prifly";
import { rawIssue } from "./fixtures";

const TOKEN = "sntryu_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const NEW = "sntryu_cccccccccccccccccccccccccccccccc";
const realFetch = globalThis.fetch;
let stop: (() => void) | null = null;

afterEach(() => {
  globalThis.fetch = realFetch;
  stop?.();
  stop = null;
});

type Seen = { url: string; auth: string };

/** Sentry, answering as a token it accepts; any other token gets a 401. */
function sentry(accepts: string[]): Seen[] {
  const seen: Seen[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const auth = new Headers(init?.headers).get("Authorization") ?? "";
    seen.push({ url, auth });
    if (!accepts.some((token) => auth === `Bearer ${token}`)) {
      return Response.json({ detail: "Invalid token" }, { status: 401 });
    }
    if (url.includes("/auth/")) return Response.json({ name: "Ada Lovelace" });
    if (url.includes("/api/0/organizations/?")) {
      return Response.json([{ slug: "acme", name: "Acme", links: { regionUrl: "" } }]);
    }
    if (url.includes("/issues/?")) return Response.json([rawIssue]);
    return Response.json([]);
  }) as unknown as typeof fetch;
  return seen;
}

async function start(fake: FakePrifly): Promise<void> {
  stop = await activate(fake.api);
}

const rowsOf = async (): Promise<LaunchChoice[]> => (await choices("issue", "")) as LaunchChoice[];
const titles = (rows: LaunchChoice[]) => rows.map((row) => row.title);

describe("an older prifly", () => {
  const missing: Needed[] = ["settings", "state", "vault-file"];

  for (const lacks of missing) {
    test(`without ${lacks}: only the Update row, and nothing else runs`, async () => {
      const seen = sentry([TOKEN]);
      const fake = fakePrifly("/x", {
        without: [lacks],
        settings: { ...SETTING_DEFAULTS, org: "acme" },
      });
      fake.entries.set("sentry", TOKEN);
      await start(fake);
      const rows = await rowsOf();
      expect(titles(rows)).toEqual(["Update prifly to use this extension"]);
      expect(rows[0]?.tone).toBe("warning");
      // The Update row starts nothing.
      expect(await launch("issue", rows[0]?.key ?? "", "")).toMatchObject({ prompt: "" });
      expect(seen).toEqual([]);
      expect(fake.filed).toEqual([]);
      expect(fake.database.writes()).toBe(0);
    });
  }

  test("the log-in rows are not offered either", async () => {
    sentry([TOKEN]);
    const fake = fakePrifly("/x", { without: ["vault-file"] });
    await start(fake);
    const rows = await rowsOf();
    expect(rows.some((row) => row.key === "setup:paste-token")).toBe(false);
  });
});

describe("logged out", () => {
  test("the two login rows, and not one call to Sentry", async () => {
    const seen = sentry([TOKEN]);
    const fake = fakePrifly("/x");
    await start(fake);
    const rows = await rowsOf();
    expect(rows.map((row) => row.key)).toContain("setup:open-token-page");
    expect(rows.map((row) => row.key)).toContain("setup:paste-token");
    expect(rows.find((row) => row.key === "setup:paste-token")?.detail).toContain("prifly's vault");
    expect(seen).toEqual([]);
  });
});

describe("logging in", () => {
  test("the pasted token is filed in the vault entry sentry, then the issue list loads", async () => {
    const seen = sentry([TOKEN]);
    const folder = mkdtempSync(join(tmpdir(), "sentry-states-"));
    const fake = fakePrifly(folder);
    await start(fake);

    const done = await launch("issue", "setup:paste-token", TOKEN);
    expect(done.message).toBe("Logged in as Ada Lovelace.");
    expect(fake.filed).toHaveLength(1);
    expect(fake.filed[0]?.name).toBe("sentry");
    expect(fake.filed[0]?.request.token).toBe(TOKEN);
    expect(fake.entries.get("sentry")).toBe(TOKEN);

    // Logged in, no organization yet: the organizations are offered.
    const orgs = await rowsOf();
    expect(titles(orgs)).toEqual(["Acme"]);
    await launch("issue", "setup:org:acme", "");

    const board = (await choices("issue", "")) as LaunchBoard;
    expect(board.items.length).toBeGreaterThan(0);
    expect(board.items[0]?.title).toContain(rawIssue.title);
    expect(seen.every((call) => call.auth === `Bearer ${TOKEN}`)).toBe(true);
    expect(fake.logs.join("\n")).not.toContain(TOKEN);
    // The token is in the vault only: no auth.json, no marker, nothing written to the folder.
    expect(readdirSync(folder)).toEqual([]);
  });

  test("a declined card saves nothing and the login rows stay", async () => {
    sentry([TOKEN]);
    const fake = fakePrifly("/x", { answer: "declined" });
    await start(fake);
    const done = await launch("issue", "setup:paste-token", TOKEN);
    expect(done.message).toContain("declined");
    expect(done.message).not.toContain(TOKEN);
    expect(fake.entries.size).toBe(0);
    expect(titles(await rowsOf())).toContain("2. Paste the token Sentry shows you");
  });

  test("a token Sentry does not accept is not filed", async () => {
    sentry([]);
    const fake = fakePrifly("/x");
    await start(fake);
    await expect(launch("issue", "setup:paste-token", TOKEN)).rejects.toThrow("401");
    expect(fake.filed).toEqual([]);
    expect(fake.entries.size).toBe(0);
  });

  test("something that is not a token is refused before Sentry is asked", async () => {
    const seen = sentry([TOKEN]);
    const fake = fakePrifly("/x");
    await start(fake);
    await expect(launch("issue", "setup:paste-token", "not a token")).rejects.toThrow(
      "not a Sentry token",
    );
    expect(seen).toEqual([]);
  });
});

describe("a saved token Sentry no longer accepts", () => {
  test("the list says so and offers a new token or a log out, instead of an error", async () => {
    sentry([NEW]);
    const fake = fakePrifly("/x", { settings: { ...SETTING_DEFAULTS, org: "acme" } });
    fake.entries.set("sentry", TOKEN);
    await start(fake);
    const rows = await rowsOf();
    expect(rows[0]?.title).toBe("Sentry refused the saved token");
    expect(rows[0]?.tone).toBe("warning");
    expect(rows.map((row) => row.key)).toContain("setup:paste-token");
    expect(rows.map((row) => row.key)).toContain("setup:log-out");
  });

  test("pasting a new token replaces it and the list loads", async () => {
    sentry([NEW]);
    const fake = fakePrifly("/x", { settings: { ...SETTING_DEFAULTS, org: "acme" } });
    fake.entries.set("sentry", TOKEN);
    await start(fake);
    expect((await rowsOf())[0]?.title).toBe("Sentry refused the saved token");
    await launch("issue", "setup:paste-token", NEW);
    expect(fake.entries.get("sentry")).toBe(NEW);
    const board = (await choices("issue", "")) as LaunchBoard;
    expect(board.items.length).toBeGreaterThan(0);
  });
});

describe("logging out", () => {
  test("the vault entry is forgotten and the login rows come back", async () => {
    sentry([TOKEN]);
    const fake = fakePrifly("/x");
    await start(fake);
    await launch("issue", "setup:paste-token", TOKEN);
    await launch("issue", "setup:org:acme", "");
    const done = await launch("issue", "setup:log-out", "");
    expect(done.message).toContain("Logged out");
    expect(fake.forgotten).toEqual(["sentry"]);
    expect(fake.entries.size).toBe(0);
    expect(titles(await rowsOf())).toContain("2. Paste the token Sentry shows you");
  });

  test("an entry the reader made themselves stays, and the message says so", async () => {
    sentry([TOKEN]);
    const fake = fakePrifly("/x", { ownEntry: false });
    fake.entries.set("sentry", TOKEN);
    await start(fake);
    const done = await launch("issue", "setup:log-out", "");
    expect(done.message).toContain("one you made yourself");
    expect(fake.entries.get("sentry")).toBe(TOKEN);
  });
});
