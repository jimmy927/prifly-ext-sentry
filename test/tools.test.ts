import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionTool, ExtensionToolContext } from "../prifly-api";
import { sentryTools } from "../tools";
import { load } from "../world";
import { type FakePrifly, fakePrifly } from "./fake-prifly";
import { pythonEvent, rawIssue } from "./fixtures";

const TOKEN = "sntryu_0123456789abcdef0123456789abcdef0123456789";
const REGION = "https://de.sentry.io";
const realFetch = globalThis.fetch;

type Seen = { url: URL; auth: string | null };
class Failure {
  status: number;
  body: unknown;
  constructor(status: number, body?: unknown) {
    this.status = status;
    this.body = body;
  }
}

/** The requests since the last `fakeFetch`; loading the world asks who the token is, which is not under test. */
let requests: Seen[] = [];

/** Replaces fetch with answers by path; every request is recorded. */
function fakeFetch(answers: Record<string, unknown>): Seen[] {
  const seen: Seen[] = [];
  requests = seen;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const headers = new Headers(init?.headers);
    seen.push({ url, auth: headers.get("Authorization") });
    const answer = answers[url.pathname];
    if (answer === undefined) return Response.json({ detail: "nothing here" }, { status: 404 });
    if (answer instanceof Failure) {
      return Response.json(answer.body ?? { detail: "failed" }, { status: answer.status });
    }
    return Response.json(answer);
  }) as typeof fetch;
  return seen;
}

afterEach(() => {
  globalThis.fetch = realFetch;
});

async function setup(options: { token?: boolean; org?: string } = {}) {
  const fake: FakePrifly = fakePrifly("/x", { settings: { org: options.org ?? "acme" } });
  if (options.token !== false) fake.secrets.set("token", TOKEN);
  await fake.database.set("choices", { regions: { acme: REGION } });
  const world = await load(fake.api);
  requests.length = 0;
  const tools = new Map(sentryTools(() => world).map((tool) => [tool.name, tool]));
  const scratchpad = mkdtempSync(join(tmpdir(), "sentry-tools-"));
  const ctx = {
    session: "s1",
    signal: new AbortController().signal,
    pick: async () => null,
    scratchpad,
  } as ExtensionToolContext;
  const call = (name: string, args: Record<string, unknown>) => {
    const tool: ExtensionTool | undefined = tools.get(name);
    if (tool === undefined) throw new Error(`no tool ${name}`);
    return tool.call(args, ctx);
  };
  return { fake, call, scratchpad, tools };
}

const issuePath = "/api/0/organizations/acme/issues/5001/";

describe("the tools", () => {
  test("are the four read tools, named for a session", async () => {
    const { tools } = await setup();
    expect([...tools.keys()]).toEqual([
      "sentry_search",
      "sentry_issue",
      "sentry_events",
      "sentry_event",
    ]);
    for (const tool of tools.values()) {
      expect(tool.name).toMatch(/^[a-z][a-z0-9_]{0,47}$/);
      expect(tool.inputSchema["type"]).toBe("object");
    }
  });
});

describe("sentry_search", () => {
  test("asks the organization's issues in its region, with is:unresolved added", async () => {
    const seen = fakeFetch({ "/api/0/organizations/acme/issues/": [rawIssue] });
    const { call } = await setup();
    const out = await call("sentry_search", {
      query: "Failed to fetch",
      project: "shop",
      sort: "freq",
      period: "7d",
      limit: 10,
    });
    expect(seen).toHaveLength(1);
    const { url, auth } = seen[0] as Seen;
    expect(url.origin).toBe(REGION);
    expect(auth).toBe(`Bearer ${TOKEN}`);
    expect(url.searchParams.get("query")).toBe("project:shop is:unresolved Failed to fetch");
    expect(url.searchParams.get("sort")).toBe("freq");
    expect(url.searchParams.get("statsPeriod")).toBe("7d");
    expect(url.searchParams.get("limit")).toBe("10");
    expect(url.searchParams.get("project")).toBe("-1");
    expect(out).toContain("SHOP-1A2");
    expect(out).toContain("KeyError: 'basket'");
    expect(out).toContain("id=5001");
  });

  test("keeps the query's own is: and defaults the rest", async () => {
    const seen = fakeFetch({ "/api/0/organizations/acme/issues/": [] });
    const { call } = await setup();
    expect(await call("sentry_search", { query: "is:resolved release:abc" })).toBe(
      "no issues match",
    );
    const params = (seen[0] as Seen).url.searchParams;
    expect(params.get("query")).toBe("is:resolved release:abc");
    expect(params.get("sort")).toBe("date");
    expect(params.get("statsPeriod")).toBe("14d");
    expect(params.get("limit")).toBe("25");
  });

  test("an org argument wins, and its region is looked up", async () => {
    const seen = fakeFetch({
      "/api/0/organizations/": [{ slug: "other", links: { regionUrl: "https://us.sentry.io" } }],
      "/api/0/organizations/other/issues/": [],
    });
    const { call } = await setup();
    await call("sentry_search", { org: "other" });
    expect(seen.map((one) => one.url.origin)).toEqual([
      "https://sentry.io",
      "https://us.sentry.io",
    ]);
    expect((seen[1] as Seen).url.pathname).toBe("/api/0/organizations/other/issues/");
  });
});

describe("sentry_issue", () => {
  const answers = {
    "/api/0/organizations/acme/shortids/SHOP-1A2/": { groupId: "5001" },
    [issuePath]: rawIssue,
    [`${issuePath}events/latest/`]: pythonEvent,
  };

  test("resolves a short id and tells the issue and its latest event", async () => {
    const seen = fakeFetch(answers);
    const { call } = await setup();
    const out = await call("sentry_issue", { issue: "shop-1a2" });
    expect(seen.map((one) => one.url.pathname)).toEqual([
      "/api/0/organizations/acme/shortids/SHOP-1A2/",
      issuePath,
      `${issuePath}events/latest/`,
    ]);
    expect(out).toStartWith("# KeyError: 'basket'");
    expect(out).toContain("escalating");
    expect(out).toContain("shop/basket.py:12 in load");
    expect(out).toContain("payments.example/charge");
    expect(out).toContain("POST https://shop.example/api/checkout");
    expect(out).toContain("environment: production");
    expect(out).toContain("Grace");
    expect(out).toContain("seen after deploy");
  });

  test("takes an issue URL or a numeric id without asking for the short id", async () => {
    const seen = fakeFetch(answers);
    const { call } = await setup();
    await call("sentry_issue", { issue: "https://example-org.sentry.io/issues/5001/?x=1" });
    await call("sentry_issue", { issue: "5001" });
    expect(seen.some((one) => one.url.pathname.includes("shortids"))).toBe(false);
    expect(seen).toHaveLength(4);
  });

  test("an issue with no stored event still gives its facts", async () => {
    fakeFetch({ [issuePath]: rawIssue });
    const { call } = await setup();
    const out = await call("sentry_issue", { issue: "5001" });
    expect(out).toContain("KeyError: 'basket'");
    expect(out).toContain("no stored event");
  });

  test("an unknown short id is a clear 404", async () => {
    fakeFetch({});
    const { call } = await setup();
    await expect(call("sentry_issue", { issue: "NOPE-1" })).rejects.toThrow(/404/);
  });

  test("needs an issue", async () => {
    const { call } = await setup();
    await expect(call("sentry_issue", {})).rejects.toThrow("`issue` is required");
  });
});

describe("sentry_events", () => {
  test("lists an issue's events in lines, asking for that many", async () => {
    const seen = fakeFetch({
      [`${issuePath}events/`]: [
        {
          eventID: "e1",
          dateCreated: "2026-09-25T11:00:00.000Z",
          message: "boom",
          tags: [{ key: "release", value: "shop@1.5.2-long-version" }],
          user: { email: "a@example.com" },
        },
        { eventID: "e2", dateCreated: "2026-09-25T10:00:00Z", title: "again", tags: [] },
      ],
    });
    const { call } = await setup();
    const out = await call("sentry_events", { issue: "5001", limit: 2 });
    expect((seen[0] as Seen).url.searchParams.get("per_page")).toBe("2");
    const lines = out.split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("e1  2026-09-25T11:00:00  release=shop@1.5.2-…");
    expect(lines[0]).toContain("a@example.com  boom");
    expect(lines[1]).toContain("e2");
    expect(lines[1]).toContain("again");
  });
});

describe("sentry_event", () => {
  const answers = {
    [issuePath]: rawIssue,
    [`${issuePath}events/latest/`]: pythonEvent,
    [`${issuePath}events/oldest/`]: { ...pythonEvent, eventID: "old1" },
  };

  test("reads the latest by default, or oldest / an id as asked", async () => {
    const seen = fakeFetch(answers);
    const { call } = await setup();
    const latest = await call("sentry_event", { issue: "5001" });
    expect(latest).toContain("abc123");
    const oldest = await call("sentry_event", { issue: "5001", event: "oldest" });
    expect(oldest).toContain("old1");
    expect(seen.map((one) => one.url.pathname)).toContain(`${issuePath}events/oldest/`);
  });

  test("save writes the whole event into the scratchpad and returns its path", async () => {
    fakeFetch(answers);
    const { call, scratchpad } = await setup();
    const out = await call("sentry_event", { issue: "5001", save: true });
    const path = join(scratchpad, "sentry-SHOP-1A2-abc123.json");
    expect(out).toContain(`Saved the whole event JSON to ${path}`);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(pythonEvent);
    expect(out).toContain("shop/basket.py:12 in load");
  });

  test("save without a scratchpad says so", async () => {
    fakeFetch(answers);
    const { tools } = await setup();
    const ctx = {
      session: "s",
      signal: new AbortController().signal,
      pick: async () => null,
      get scratchpad(): string {
        throw new Error("no transcript");
      },
    } as ExtensionToolContext;
    await expect(
      tools.get("sentry_event")?.call({ issue: "5001", save: true }, ctx),
    ).rejects.toThrow("no scratchpad folder (no transcript)");
  });
});

describe("failures", () => {
  test("not logged in says so, and calls nothing", async () => {
    const seen = fakeFetch({});
    const { call } = await setup({ token: false });
    for (const name of ["sentry_search", "sentry_issue", "sentry_events", "sentry_event"]) {
      await expect(call(name, { issue: "5001" })).rejects.toThrow("Not logged in to Sentry");
    }
    expect(seen).toHaveLength(0);
  });

  test("no organization asks for one", async () => {
    fakeFetch({});
    const { call } = await setup({ org: "" });
    await expect(call("sentry_search", {})).rejects.toThrow("No Sentry organization");
  });

  test("a 403 names the permission the token needs", async () => {
    fakeFetch({ "/api/0/organizations/acme/issues/": new Failure(403) });
    const { call } = await setup();
    await expect(call("sentry_search", {})).rejects.toThrow("the token needs Issue & Event: Read");
  });

  test("a 401 says to log in again", async () => {
    fakeFetch({ "/api/0/organizations/acme/issues/": new Failure(401) });
    const { call } = await setup();
    await expect(call("sentry_search", {})).rejects.toThrow("refused the token (401)");
  });

  test("the token is in no output and no error, even when Sentry echoes it", async () => {
    const echo = new Failure(500, { detail: `bad request for ${TOKEN}` });
    fakeFetch({ "/api/0/organizations/acme/issues/": echo });
    const { call, fake } = await setup();
    const caught = await call("sentry_search", {}).catch((error: Error) => error.message);
    expect(caught).toContain("500");
    expect(caught).not.toContain(TOKEN);
    expect(caught).toContain("[token]");

    fakeFetch({
      [issuePath]: { ...rawIssue, title: `leaked ${TOKEN}` },
      [`${issuePath}events/latest/`]: pythonEvent,
    });
    const out = await call("sentry_issue", { issue: "5001" });
    expect(out).not.toContain(TOKEN);
    expect(fake.logs.join("\n")).not.toContain(TOKEN);
  });
});
