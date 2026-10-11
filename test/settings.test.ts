import { describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseProjectFolders, SETTING_DEFAULTS } from "../settings";
import {
  applySettings,
  changeState,
  choose,
  effectiveConfig,
  linkIssue,
  load,
  parseConfig,
  supported,
} from "../world";
import { fakePrifly, type Needed } from "./fake-prifly";

const atDefaults: Record<string, string | number> = { ...SETTING_DEFAULTS };

describe("the manifest", () => {
  test("declares every setting with the default settings.ts assumes", () => {
    const manifest = JSON.parse(
      readFileSync(join(import.meta.dir, "..", "prifly-extension.json"), "utf8"),
    );
    const declared = Object.fromEntries(
      manifest.settings.map((field: { id: string; default: unknown }) => [field.id, field.default]),
    );
    for (const [id, value] of Object.entries(SETTING_DEFAULTS)) expect(declared[id]).toEqual(value);
    for (const field of manifest.settings) {
      expect(["boolean", "number", "string", "choices"]).toContain(field.type);
      expect(field.label).not.toBe("");
      expect(field.description).not.toBe("");
    }
  });
});

describe("parseProjectFolders", () => {
  test("reads slug=folder pairs separated by ; or line breaks", () => {
    expect(parseProjectFolders("odi=/home/me/odi; web = ~/src/web\nshop=/x\r\n")).toEqual({
      odi: "/home/me/odi",
      web: "~/src/web",
      shop: "/x",
    });
  });

  test("a Windows path survives: no split on : or \\", () => {
    expect(parseProjectFolders("odi=C:\\Users\\x\\src\\odi")).toEqual({
      odi: "C:\\Users\\x\\src\\odi",
    });
    expect(parseProjectFolders('odi="C:\\Users\\x y\\src\\odi";web=\\\\host\\share\\web')).toEqual({
      odi: "C:\\Users\\x y\\src\\odi",
      web: "\\\\host\\share\\web",
    });
  });

  test("a folder may hold an = after the first one", () => {
    expect(parseProjectFolders("a=/x/b=c")).toEqual({ a: "/x/b=c" });
  });

  test("skips what is not a pair, and the later pair for a slug wins", () => {
    expect(parseProjectFolders("nofolder; =/x; empty=; a=/1; a=/2; junk")).toEqual({ a: "/2" });
    expect(parseProjectFolders("")).toEqual({});
    expect(parseProjectFolders(42)).toEqual({});
  });
});

describe("the settings alone", () => {
  test("settings at their defaults give the defaults", () => {
    expect(effectiveConfig(atDefaults, {})).toEqual(parseConfig({}, "/h"));
  });

  test("SENTRY_ORG and SENTRY_URL in the environment do not set the organization or the address", () => {
    const saved = { org: Bun.env["SENTRY_ORG"], url: Bun.env["SENTRY_URL"] };
    Bun.env["SENTRY_ORG"] = "env-org";
    Bun.env["SENTRY_URL"] = "https://env.example";
    try {
      const config = effectiveConfig(atDefaults, {});
      expect(config.org).toBe("");
      expect(config.baseUrl).toBe("https://sentry.io");
    } finally {
      if (saved.org === undefined) delete Bun.env["SENTRY_ORG"];
      else Bun.env["SENTRY_ORG"] = saved.org;
      if (saved.url === undefined) delete Bun.env["SENTRY_URL"];
      else Bun.env["SENTRY_URL"] = saved.url;
    }
  });

  test("every setting takes effect, trimmed, with the folders as projects", () => {
    const config = effectiveConfig(
      {
        ...atDefaults,
        org: " morpheus-0r ",
        baseUrl: "https://sentry.example.com/",
        projectFolders: "odi=C:\\Users\\x\\src\\odi;new=~/new",
        query: " is:unresolved level:error ",
        period: "30d",
        sort: "user",
        refreshSeconds: 60,
        startSessions: true,
        startMaxAgeHours: 6,
      },
      {},
    );
    expect(config).toMatchObject({
      org: "morpheus-0r",
      baseUrl: "https://sentry.example.com",
      query: "is:unresolved level:error",
      period: "30d",
      sort: "user",
      refreshSeconds: 60,
    });
    expect(config.projects["odi"]).toBe("C:\\Users\\x\\src\\odi");
    expect(config.projects["new"]).toMatch(/\/new$/);
    expect(config.startSessions).toMatchObject({ enabled: true, maxAgeHours: 6 });
  });

  test("an emptied query means every issue, an emptied org means none chosen", () => {
    expect(effectiveConfig({ ...atDefaults, query: "" }, {}).query).toBe("");
    expect(effectiveConfig({ ...atDefaults, org: "  " }, {}).org).toBe("");
  });
});

const newFolder = () => mkdtempSync(join(tmpdir(), "sentry-settings-"));

describe("load", () => {
  test("takes the settings, and no file in the folder is looked at or made", async () => {
    const folder = newFolder();
    const fake = fakePrifly(folder, { settings: { ...atDefaults, period: "7d" } });
    const world = await load(fake.api);
    expect(world.config.org).toBe("");
    expect(world.config.period).toBe("7d");
    expect(fake.logs).toEqual([]);
    expect(readdirSync(folder)).toEqual([]);
  });
});

describe("the chooser's choices", () => {
  test("a choice is kept in api.state and still there after a restart", async () => {
    const first = fakePrifly(newFolder(), { settings: { ...atDefaults } });
    const world = await load(first.api);
    await choose(world, { org: "picked" });
    await choose(world, { sort: "freq" });
    expect(world.config).toMatchObject({ org: "picked", sort: "freq" });
    expect(JSON.parse(first.database.docs.get("choices") ?? "null")).toEqual({
      org: { value: "picked", over: "" },
      sort: { value: "freq", over: "date" },
    });

    const second = fakePrifly(newFolder(), {
      settings: { ...atDefaults },
      database: first.database,
    });
    expect((await load(second.api)).config).toMatchObject({ org: "picked", sort: "freq" });
  });

  test("a setting the reader changes afterwards wins over the older choice", async () => {
    const fake = fakePrifly(newFolder(), { settings: { ...atDefaults } });
    const world = await load(fake.api);
    await choose(world, { org: "picked", sort: "freq" });
    // the reader types an organization on the Extensions page; the sort is left alone
    (fake.api.settings as Record<string, unknown>)["org"] = "typed";
    applySettings(world);
    expect(world.config).toMatchObject({ org: "typed", sort: "freq" });
    // set back to what it was when the choice was made, the choice stands again
    (fake.api.settings as Record<string, unknown>)["org"] = "";
    applySettings(world);
    expect(world.config.org).toBe("picked");
  });

  test("switching organization is a choice too, and survives a restart", async () => {
    const settings = { ...atDefaults, org: "from-settings" };
    const first = fakePrifly(newFolder(), { settings });
    const world = await load(first.api);
    expect(world.config.org).toBe("from-settings");
    await choose(world, { org: "" });
    const again = await load(
      fakePrifly(newFolder(), { settings: { ...settings }, database: first.database }).api,
    );
    expect(again.config.org).toBe("");
  });
});

describe("the state document", () => {
  test("starts empty, and nothing is stored or written until something changes", async () => {
    const folder = newFolder();
    const fake = fakePrifly(folder);
    const world = await load(fake.api);
    expect(world.state).toEqual({ links: {}, linkedAt: {}, folders: {}, attempted: {} });
    expect(fake.database.docs.has("state")).toBe(false);
    expect(readdirSync(folder)).toEqual([]);
  });

  test("a state.json in the folder is not imported", async () => {
    const folder = newFolder();
    await Bun.write(
      join(folder, "state.json"),
      JSON.stringify({ links: { s1: ["a"] }, folders: { shop: "/src/shop" } }),
    );
    const fake = fakePrifly(folder);
    const world = await load(fake.api);
    expect(world.state.links).toEqual({});
    expect(fake.database.docs.has("state")).toBe(false);
  });

  test("what the document holds is what loads", async () => {
    const first = fakePrifly(newFolder());
    await first.database.set("state", { links: { s2: ["z"] } });
    const world = await load(fakePrifly(newFolder(), { database: first.database }).api);
    expect(world.state.links).toEqual({ s2: ["z"] });
    expect(world.state.folders).toEqual({});
  });

  test("changes go through update, so two at once both stay", async () => {
    const folder = newFolder();
    const fake = fakePrifly(folder);
    const world = await load(fake.api);
    await Promise.all([
      changeState(world, (state) => linkIssue(state, "s1", "a", 1)),
      changeState(world, (state) => linkIssue(state, "s2", "b", 2)),
      changeState(world, (state) => {
        state.folders["shop"] = "/src/shop";
      }),
    ]);
    const stored = JSON.parse(fake.database.docs.get("state") ?? "null") as typeof world.state;
    expect(stored.links).toEqual({ s1: ["a"], s2: ["b"] });
    expect(stored.folders).toEqual({ shop: "/src/shop" });
    expect(world.state).toEqual(stored);
    expect(readdirSync(folder)).toEqual([]);
  });
});

describe("a prifly without settings, state or the vault-file feature", () => {
  const missing: Needed[] = ["settings", "state", "vault-file"];

  test("all three present is supported, any one missing is not", () => {
    expect(supported(fakePrifly("/x").api)).toBe(true);
    for (const lacks of missing) {
      expect(supported(fakePrifly("/x", { without: [lacks] }).api)).toBe(false);
    }
  });

  test("a feature named without the api behind it, or the api without the feature, is not supported", () => {
    const api = fakePrifly("/x").api;
    const { settings: _settings, ...noSettings } = api;
    expect(supported(noSettings as typeof api)).toBe(false);
    expect(supported({ ...api, features: ["settings", "state"] })).toBe(false);
    expect(supported({ ...api, features: [] })).toBe(false);
  });

  test("the world is empty and nothing is read: no state, no vault, no network", async () => {
    const realFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      return Response.json({});
    }) as unknown as typeof fetch;
    try {
      for (const lacks of missing) {
        const folder = newFolder();
        const fake = fakePrifly(folder, { without: [lacks] });
        fake.entries.set("sentry", "sntryu_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
        const world = await load(fake.api);
        expect(world.login).toBeNull();
        expect(world.state).toEqual({ links: {}, linkedAt: {}, folders: {}, attempted: {} });
        expect(fake.logs).toEqual([]);
        expect(readdirSync(folder)).toEqual([]);
      }
      expect(calls).toBe(0);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});
