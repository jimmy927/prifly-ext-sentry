import { describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionApi } from "../prifly-api";
import { parseProjectFolders, SETTING_DEFAULTS } from "../settings";
import {
  applySettings,
  changeState,
  choose,
  effectiveConfig,
  linkIssue,
  load,
  parseConfig,
} from "../world";

// effectiveConfig reads the environment; these tests mean a machine without it.
delete Bun.env["SENTRY_ORG"];
delete Bun.env["SENTRY_URL"];

const clirc = { token: "", org: "", url: "" };
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
    expect(effectiveConfig(atDefaults, {}, clirc)).toEqual(parseConfig({}, {}, clirc, "/h"));
  });

  test("org and address at their defaults leave the environment and ~/.sentryclirc in charge", () => {
    const rc = { ...clirc, org: "rc-org", url: "https://self.example/" };
    const config = effectiveConfig(atDefaults, {}, rc);
    expect(config.baseUrl).toBe("https://self.example");
    expect(config.org).toBe("rc-org");
    expect(effectiveConfig({ ...atDefaults, baseUrl: "https://sentry.io" }, {}, rc).baseUrl).toBe(
      "https://self.example",
    );
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
      clirc,
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

  test("an emptied query means every issue, an emptied org falls to the login's", () => {
    expect(effectiveConfig({ ...atDefaults, query: "" }, {}, clirc).query).toBe("");
    expect(effectiveConfig({ ...atDefaults, org: "  " }, {}, { ...clirc, org: "rc" }).org).toBe(
      "rc",
    );
  });
});

/** The slice of `api.state` the extension uses, in memory: writes to one name run in turn, like prifly's. */
function fakeState(initial: Record<string, unknown> = {}) {
  const docs = new Map<string, unknown>(Object.entries(initial));
  let tail: Promise<unknown> = Promise.resolve();
  const inLine = <T>(job: () => Promise<T>): Promise<T> => {
    const run = tail.then(job, job);
    tail = run.catch(() => undefined);
    return run;
  };
  const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value));
  const store = {
    get: async (name: string) => (docs.has(name) ? copy(docs.get(name)) : undefined),
    update: (name: string, fn: (current: unknown) => unknown) =>
      inLine(async () => {
        const next = copy(await fn(docs.has(name) ? copy(docs.get(name)) : undefined));
        docs.set(name, next);
        return copy(next);
      }),
    importOnce: (name: string, make: () => unknown) =>
      inLine(async () => {
        if (docs.has(name)) return copy(docs.get(name));
        const made = await make();
        if (made === undefined) return undefined;
        docs.set(name, copy(made));
        return copy(made);
      }),
  };
  return { docs, store: store as unknown as NonNullable<ExtensionApi["state"]> };
}

function fakeApi(
  folder: string,
  extra: Partial<ExtensionApi>,
): {
  api: ExtensionApi;
  logged: { event: string; fields?: Record<string, unknown> | undefined }[];
} {
  const logged: { event: string; fields?: Record<string, unknown> | undefined }[] = [];
  const api = {
    folder,
    log: (event: string, fields?: Record<string, unknown>) => logged.push({ event, fields }),
    sessions: () => [],
    ...extra,
  } as unknown as ExtensionApi;
  return { api, logged };
}

const newFolder = () => mkdtempSync(join(tmpdir(), "sentry-settings-"));
const withBoth = (
  store: ReturnType<typeof fakeState>["store"],
  settings: Record<string, string | number> = atDefaults,
) => ({
  features: ["settings", "state"],
  settings: { ...settings },
  state: store,
});

describe("load", () => {
  test("takes the settings, and a config.json beside it is never looked at", async () => {
    const folder = newFolder();
    writeFileSync(join(folder, "config.json"), JSON.stringify({ org: "file-org", period: "30d" }));
    const { store } = fakeState();
    const { api, logged } = fakeApi(folder, withBoth(store, { ...atDefaults, period: "7d" }));
    const world = await load(api);
    expect(world.config.org).toBe("");
    expect(world.config.period).toBe("7d");
    expect(logged).toEqual([]);
    expect(JSON.parse(readFileSync(join(folder, "config.json"), "utf8"))).toEqual({
      org: "file-org",
      period: "30d",
    });
  });
});

describe("the chooser's choices", () => {
  test("a choice is kept in api.state and still there after a restart", async () => {
    const folder = newFolder();
    const { docs, store } = fakeState();
    const first = await load(fakeApi(folder, withBoth(store)).api);
    await choose(first, { org: "picked" });
    await choose(first, { sort: "freq" });
    expect(first.config).toMatchObject({ org: "picked", sort: "freq" });
    expect(docs.get("choices")).toEqual({
      org: { value: "picked", over: "" },
      sort: { value: "freq", over: "date" },
    });

    const second = await load(fakeApi(folder, withBoth(store)).api);
    expect(second.config).toMatchObject({ org: "picked", sort: "freq" });
  });

  test("a setting the reader changes afterwards wins over the older choice", async () => {
    const folder = newFolder();
    const { store } = fakeState();
    const settings = { ...atDefaults };
    const { api } = fakeApi(folder, withBoth(store, settings));
    const world = await load(api);
    await choose(world, { org: "picked", sort: "freq" });
    // the reader types an organization on the Extensions page; the sort is left alone
    (api.settings as Record<string, unknown>)["org"] = "typed";
    await applySettings(world);
    expect(world.config).toMatchObject({ org: "typed", sort: "freq" });
    // set back to what it was when the choice was made, the choice stands again
    (api.settings as Record<string, unknown>)["org"] = "";
    await applySettings(world);
    expect(world.config.org).toBe("picked");
  });

  test("switching organization is a choice too, and survives a restart", async () => {
    const folder = newFolder();
    const { store } = fakeState();
    const settings = { ...atDefaults, org: "from-settings" };
    const world = await load(fakeApi(folder, withBoth(store, settings)).api);
    expect(world.config.org).toBe("from-settings");
    await choose(world, { org: "" });
    const again = await load(fakeApi(folder, withBoth(store, settings)).api);
    expect(again.config.org).toBe("");
  });
});

describe("state.json, imported once", () => {
  const legacy = {
    links: { s1: ["a", "b"] },
    linkedAt: { a: 5 },
    folders: { shop: "/src/shop" },
    attempted: { a: { at: 9, started: true } },
  };

  test("a state.json that is there becomes the state document, and is left alone", async () => {
    const folder = newFolder();
    const text = JSON.stringify(legacy);
    writeFileSync(join(folder, "state.json"), text);
    const { docs, store } = fakeState();
    const world = await load(fakeApi(folder, withBoth(store)).api);
    expect(world.state).toEqual({ ...legacy, linkedAt: { a: 5 } });
    expect(docs.get("state")).toEqual(world.state);
    expect(readFileSync(join(folder, "state.json"), "utf8")).toBe(text);
  });

  test("no state.json: nothing is stored and no file is made", async () => {
    const folder = newFolder();
    const { docs, store } = fakeState();
    const world = await load(fakeApi(folder, withBoth(store)).api);
    expect(world.state).toEqual({ links: {}, linkedAt: {}, folders: {}, attempted: {} });
    expect(docs.has("state")).toBe(false);
    expect(readdirSync(folder)).toEqual([]);
  });

  test("an unreadable state.json imports nothing", async () => {
    const folder = newFolder();
    writeFileSync(join(folder, "state.json"), "{ not json");
    const { docs, store } = fakeState();
    await load(fakeApi(folder, withBoth(store)).api);
    expect(docs.has("state")).toBe(false);
  });

  test("already imported: the document wins and the file is not read again", async () => {
    const folder = newFolder();
    writeFileSync(join(folder, "state.json"), JSON.stringify(legacy));
    const { store } = fakeState({ state: { links: { s2: ["z"] } } });
    const world = await load(fakeApi(folder, withBoth(store)).api);
    expect(world.state.links).toEqual({ s2: ["z"] });
    expect(world.state.folders).toEqual({});
  });

  test("changes go through update, so two at once both stay", async () => {
    const folder = newFolder();
    const { docs, store } = fakeState();
    const world = await load(fakeApi(folder, withBoth(store)).api);
    await Promise.all([
      changeState(world, (state) => linkIssue(state, "s1", "a", 1)),
      changeState(world, (state) => linkIssue(state, "s2", "b", 2)),
      changeState(world, (state) => {
        state.folders["shop"] = "/src/shop";
      }),
    ]);
    const stored = docs.get("state") as typeof world.state;
    expect(stored.links).toEqual({ s1: ["a"], s2: ["b"] });
    expect(stored.folders).toEqual({ shop: "/src/shop" });
    expect(world.state).toEqual(stored);
    expect(readdirSync(folder)).toEqual([]);
  });
});

describe("a prifly without settings or state", () => {
  test("says once it needs a newer prifly, keeps defaults and memory, writes no file", async () => {
    for (const extra of [{}, { features: [] }, { settings: { ...atDefaults, org: "ignored" } }]) {
      const folder = newFolder();
      writeFileSync(join(folder, "config.json"), JSON.stringify({ org: "file-org" }));
      const { api, logged } = fakeApi(folder, extra);
      const world = await load(api);
      expect(world.config).toEqual(effectiveConfig(atDefaults, {}, clirc));
      expect(logged.map((entry) => entry.event)).toEqual(["needs_newer_prifly"]);
      expect(logged[0]?.fields?.["missing"]).toBe("settings,state");

      await choose(world, { org: "picked", sort: "freq" });
      await changeState(world, (state) => linkIssue(state, "s1", "a", 1));
      expect(world.config).toMatchObject({ org: "picked", sort: "freq" });
      expect(world.state.links).toEqual({ s1: ["a"] });
      await applySettings(world);
      expect(world.config).toMatchObject({ org: "picked", sort: "freq" });
      expect(readdirSync(folder)).toEqual(["config.json"]);
      expect(logged).toHaveLength(1);
    }
  });

  test("with settings but no state, only state is reported missing", async () => {
    const { api, logged } = fakeApi(newFolder(), {
      features: ["settings"],
      settings: { ...atDefaults, org: "o" },
    });
    const world = await load(api);
    expect(world.config.org).toBe("o");
    expect(logged).toHaveLength(1);
    expect(logged[0]?.fields?.["missing"]).toBe("state");
  });
});
