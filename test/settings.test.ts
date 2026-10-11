import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionApi } from "../prifly-api";
import { fileOnlyKeys, overlaySettings, parseProjectFolders, SETTING_DEFAULTS } from "../settings";
import { applySettings, chooseInFile, load, parseConfig, settingsConfig } from "../world";

const clirc = { token: "", org: "", url: "" };
const atDefaults = { ...SETTING_DEFAULTS };

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

describe("settings over config.json", () => {
  const file = {
    org: "from-file",
    baseUrl: "https://sentry.example.com",
    projects: { odi: "/file/odi", old: "/file/old" },
    query: "is:unresolved level:error",
    period: "30d",
    sort: "freq",
    refreshSeconds: 300,
  };

  test("settings at their defaults leave config.json in force", () => {
    const config = parseConfig(overlaySettings(file, atDefaults), {}, clirc, "/h");
    expect(config).toEqual(parseConfig(file, {}, clirc, "/h"));
    expect(config.org).toBe("from-file");
    expect(config.refreshSeconds).toBe(300);
  });

  test("a setting that is not at its default wins, key by key", () => {
    const merged = overlaySettings(file, {
      ...atDefaults,
      org: " morpheus-0r ",
      sort: "user",
      projectFolders: "odi=C:\\Users\\x\\src\\odi;new=~/new",
      refreshSeconds: 60,
    });
    const config = parseConfig(merged, {}, clirc, "/home/me");
    expect(config.org).toBe("morpheus-0r");
    expect(config.sort).toBe("user");
    expect(config.refreshSeconds).toBe(60);
    // untouched keys still come from the file
    expect(config.baseUrl).toBe("https://sentry.example.com");
    expect(config.period).toBe("30d");
    expect(config.query).toBe("is:unresolved level:error");
    // per slug: the setting wins where it names one, the file fills the rest
    expect(config.projects).toEqual({
      odi: "C:\\Users\\x\\src\\odi",
      old: "/file/old",
      new: "/home/me/new",
    });
  });

  test("an emptied query means every issue, an emptied other text means unset", () => {
    expect(
      parseConfig(overlaySettings(file, { ...atDefaults, query: "" }), {}, clirc, "/h").query,
    ).toBe("");
    expect(
      parseConfig(overlaySettings(file, { ...atDefaults, org: "  " }), {}, clirc, "/h").org,
    ).toBe("from-file");
  });

  test("settings alone, with no config.json", () => {
    const config = parseConfig(
      overlaySettings(undefined, { ...atDefaults, org: "o", period: "7d" }),
      {},
      clirc,
      "/h",
    );
    expect(config).toMatchObject({
      org: "o",
      period: "7d",
      baseUrl: "https://sentry.io",
      sort: "date",
    });
  });

  test("names what only config.json supplies, for the one-time log", () => {
    expect(fileOnlyKeys(file, atDefaults).sort()).toEqual(
      ["baseUrl", "org", "period", "projectFolders", "query", "refreshSeconds", "sort"].sort(),
    );
    expect(
      fileOnlyKeys(file, {
        ...atDefaults,
        org: "x",
        sort: "date",
        projectFolders: "odi=/a;old=/b",
      }).sort(),
    ).toEqual(["baseUrl", "period", "query", "refreshSeconds", "sort"].sort());
    expect(fileOnlyKeys({}, atDefaults)).toEqual([]);
    expect(fileOnlyKeys({ org: "", sort: "date", refreshSeconds: 120 }, atDefaults)).toEqual([]);
  });
});

function fakeApi(
  folder: string,
  extra: Partial<ExtensionApi>,
): { api: ExtensionApi; logged: string[] } {
  const logged: string[] = [];
  const api = {
    folder,
    log: (event: string) => logged.push(event),
    sessions: () => [],
    ...extra,
  } as unknown as ExtensionApi;
  return { api, logged };
}

describe("load and the chooser's choices", () => {
  test("with settings: they win, config.json fills gaps and is logged once", async () => {
    const folder = mkdtempSync(join(tmpdir(), "sentry-settings-"));
    writeFileSync(join(folder, "config.json"), JSON.stringify({ org: "file-org", period: "30d" }));
    const { api, logged } = fakeApi(folder, {
      features: ["settings"],
      settings: { ...atDefaults, period: "7d", startSessions: true },
    });
    const world = await load(api);
    expect(world.config.org).toBe("file-org");
    expect(world.config.period).toBe("7d");
    expect(world.config.startSessions.enabled).toBe(true);
    expect(world.file.period).toBe("30d");
    expect(logged).toEqual(["config_json_in_use"]);
  });

  test("choosing an organization takes effect and goes to config.json only", async () => {
    const folder = mkdtempSync(join(tmpdir(), "sentry-settings-"));
    const { api } = fakeApi(folder, {
      features: ["settings"],
      settings: { ...atDefaults, period: "7d" },
    });
    const world = await load(api);
    await chooseInFile(world, { org: "picked" });
    expect(world.config.org).toBe("picked");
    const written = JSON.parse(readFileSync(join(folder, "config.json"), "utf8"));
    expect(written.org).toBe("picked");
    expect(written.period).toBe("14d"); // the setting's 7d is not copied into the file
    // a later settings change keeps the pick, the file being the fallback
    await applySettings(world);
    expect(world.config.org).toBe("picked");
    expect(world.config.period).toBe("7d");
  });

  test("without the settings feature, config.json alone, exactly as before", async () => {
    for (const extra of [
      {},
      { features: [] },
      { settings: { ...atDefaults, org: "ignored" } },
      { features: ["settings"] },
    ]) {
      const folder = mkdtempSync(join(tmpdir(), "sentry-settings-"));
      writeFileSync(join(folder, "config.json"), JSON.stringify({ org: "file-org", sort: "freq" }));
      const { api, logged } = fakeApi(folder, extra);
      expect(settingsConfig(api, { org: "file-org" }, clirc)).toBeNull();
      const world = await load(api);
      expect(world.config.org).toBe("file-org");
      expect(world.config.sort).toBe("freq");
      expect(world.config).toEqual(world.file);
      expect(logged).toEqual([]);
      await chooseInFile(world, { sort: "date" });
      expect(JSON.parse(readFileSync(join(folder, "config.json"), "utf8")).sort).toBe("date");
    }
  });
});
