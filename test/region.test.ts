import { afterEach, describe, expect, test } from "bun:test";
import type { ExtensionApi } from "../prifly-api";
import { apiBase, DEFAULT_BASE_URL } from "../region";
import { runSetup, setupChoices } from "../setup";
import { reload, type World } from "../world";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

/** Every request the extension makes, answered by the organization list or an empty list. */
function mockSentry(orgs: unknown[]): string[] {
  const urls: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    urls.push(url);
    const body = url.includes("/api/0/organizations/?") ? orgs : [];
    return new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } });
  }) as unknown as typeof fetch;
  return urls;
}

const EU = {
  slug: "eu-org",
  name: "EU Org",
  links: { organizationUrl: "https://eu-org.sentry.io", regionUrl: "https://de.sentry.io" },
};

/** The slice of `api.state` the extension uses, in memory. */
function memoryState(docs: Map<string, unknown>) {
  const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value));
  return {
    get: async (name: string) => (docs.has(name) ? copy(docs.get(name)) : undefined),
    update: async (name: string, fn: (current: unknown) => unknown) => {
      const next = copy(await fn(docs.has(name) ? copy(docs.get(name)) : undefined));
      docs.set(name, next);
      return copy(next);
    },
  } as unknown as NonNullable<ExtensionApi["state"]>;
}

function world(org: string, baseUrl: string, docs = new Map<string, unknown>()): World {
  const api = {
    show: () => undefined,
    onAction: () => undefined,
    sessions: () => [],
    log: () => undefined,
    folder: "/tmp/fake-sentry-ext",
    paths: [],
    features: ["settings", "state", "vault-file"],
    settings: {},
    vault: {
      read: async () => null,
      file: async () => ({ outcome: "declined" }),
      forget: async () => false,
    },
    state: memoryState(docs),
  } as unknown as ExtensionApi;
  return {
    api,
    config: {
      org,
      baseUrl,
      projects: {},
      query: "is:unresolved",
      period: "14d",
      sort: "date",
      refreshSeconds: 120,
      startSessions: { enabled: false, levels: ["fatal", "error"], maxPerDay: 10, maxAgeHours: 24 },
    },
    choices: {},
    login: { token: "sntryu_x", user: "me" },
    state: { links: {}, folders: {}, linkedAt: {}, attempted: {} },
    issues: [],
    mappings: [],
    loadedAt: 0,
    linked: new Map(),
    sparks: new Map(),
  };
}

const issuesCalls = (urls: string[]) => urls.filter((url) => url.includes("/issues/?"));
const lookups = (urls: string[]) => urls.filter((url) => url.includes("/api/0/organizations/?"));

describe("an organization's data region", () => {
  test("is kept when the reader picks the organization, and org calls go there", async () => {
    const urls = mockSentry([EU, { slug: "other", name: "Other", links: {} }]);
    const docs = new Map<string, unknown>();
    const w = world("", DEFAULT_BASE_URL, docs);
    await runSetup(w, "setup:org:eu-org", "");
    expect(w.config.org).toBe("eu-org");
    expect((docs.get("choices") as { regions: unknown }).regions).toEqual({
      "eu-org": "https://de.sentry.io",
    });
    expect(apiBase(w)).toBe("https://de.sentry.io");

    await reload(w);
    expect(issuesCalls(urls)[0]).toStartWith(
      "https://de.sentry.io/api/0/organizations/eu-org/issues/",
    );
    // The organization list itself is still asked of sentry.io, once.
    expect(lookups(urls)).toEqual(["https://sentry.io/api/0/organizations/?member=1"]);
  });

  test("is not used when Base URL is a self-hosted Sentry, which is not even asked", async () => {
    const urls = mockSentry([EU]);
    const docs = new Map<string, unknown>([
      ["choices", { regions: { "eu-org": "https://de.sentry.io" } }],
    ]);
    const w = world("eu-org", "https://sentry.corp.example", docs);
    w.choices = { regions: { "eu-org": "https://de.sentry.io" } };
    expect(apiBase(w)).toBe("https://sentry.corp.example");
    await reload(w);
    expect(issuesCalls(urls)[0]).toStartWith(
      "https://sentry.corp.example/api/0/organizations/eu-org/issues/",
    );

    const fresh = world("", "https://sentry.corp.example");
    const freshUrls = mockSentry([EU]);
    await runSetup(fresh, "setup:org:eu-org", "");
    expect(freshUrls).toEqual([]);
    expect(fresh.choices.regions).toBeUndefined();
    expect(apiBase(fresh)).toBe("https://sentry.corp.example");
  });

  test("of an organization chosen before regions were kept is looked up once and stored", async () => {
    const urls = mockSentry([EU]);
    const docs = new Map<string, unknown>([["choices", { org: { value: "eu-org", over: "" } }]]);
    const w = world("eu-org", DEFAULT_BASE_URL, docs);
    expect(apiBase(w)).toBe(DEFAULT_BASE_URL);
    await reload(w);
    await reload(w);
    expect(lookups(urls)).toHaveLength(1);
    expect(issuesCalls(urls).every((url) => url.startsWith("https://de.sentry.io/"))).toBe(true);
    expect(docs.get("choices")).toEqual({
      org: { value: "eu-org", over: "" },
      regions: { "eu-org": "https://de.sentry.io" },
    });
  });

  test("a failed lookup is not repeated on every refresh and leaves sentry.io in use", async () => {
    const urls: string[] = [];
    globalThis.fetch = (async (input: string | URL | Request) => {
      urls.push(String(input));
      return String(input).includes("/api/0/organizations/?")
        ? new Response("{}", { status: 500 })
        : new Response("[]");
    }) as unknown as typeof fetch;
    const w = world("eu-org", DEFAULT_BASE_URL);
    await reload(w);
    await reload(w);
    expect(lookups(urls)).toHaveLength(1);
    expect(issuesCalls(urls)[0]).toStartWith("https://sentry.io/api/0/");
  });
});

describe("the self-hosted login hint", () => {
  test("is the first, muted login row with the default Base URL, and starts nothing", async () => {
    const w = world("", DEFAULT_BASE_URL);
    w.login = null;
    const rows = (await setupChoices(w)) ?? [];
    expect(rows[0]?.tone).toBe("muted");
    expect(rows[0]?.detail).toContain("Base URL");
    expect(rows[0]?.detail).toContain("Extensions dialog (Sentry issues)");
    expect(rows[1]?.key).toBe("setup:open-token-page");
    expect(rows[0]?.input).toBeUndefined();
    expect(rows[0]?.url).toBeUndefined();

    const urls = mockSentry([]);
    expect(await runSetup(w, rows[0]?.key ?? "", "")).toEqual({ prompt: "", message: "" });
    expect(urls).toEqual([]);
  });

  test("is absent once Base URL is set", async () => {
    const w = world("", "https://sentry.corp.example");
    w.login = null;
    const rows = (await setupChoices(w)) ?? [];
    expect(rows.map((row) => row.key)).toEqual(["setup:open-token-page", "setup:paste-token"]);
  });
});
