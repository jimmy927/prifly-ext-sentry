import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkoutFor, findCheckout, isRemoteOf, mainCheckout, mainRepo } from "../checkout";
import type { CodeMapping } from "../sentry";

function mapping(repo: string, extra: Partial<CodeMapping> = {}): CodeMapping {
  return { project: "odi", repo, branch: "master", stackRoot: "", automatic: false, ...extra };
}

describe("mainRepo picks the repo the project's own code is in", () => {
  // As sentry.io had them for odi on 2026-09-30: one set up by hand, four generated.
  const odi = [
    mapping("jimmy927/PassportRFIDScanner", {
      stackRoot: "../../../../frontend/api/celtask/",
      automatic: true,
    }),
    mapping("jimmy927/requestium", { stackRoot: "requestium/", automatic: true }),
    mapping("artemisrec/odi"),
    mapping("jimmy927/avanet5", { stackRoot: "core/", automatic: true }),
  ];

  test("a hand-made mapping of the whole stack wins over generated ones", () => {
    expect(mainRepo(odi, "odi")).toBe("artemisrec/odi");
  });

  test("among generated ones, the whole stack wins over a subfolder", () => {
    const generated = [
      mapping("acme/vendored", { stackRoot: "lib/", automatic: true }),
      mapping("acme/app", { automatic: true }),
    ];
    expect(mainRepo(generated, "odi")).toBe("acme/app");
  });

  test("another project's mappings and none at all give nothing", () => {
    expect(mainRepo(odi, "web")).toBe("");
    expect(mainRepo([], "odi")).toBe("");
  });
});

describe("isRemoteOf reads every way git writes a remote", () => {
  test.each([
    "https://github.com/artemisrec/odi",
    "https://github.com/artemisrec/odi.git",
    "https://github.com/ArtemisRec/ODI/",
    "git@github.com:artemisrec/odi.git",
    "ssh://git@github.com/artemisrec/odi.git",
  ])("%s is artemisrec/odi", (url) => {
    expect(isRemoteOf(url, "artemisrec/odi")).toBe(true);
  });

  test("a repo whose name only ends the same is not it", () => {
    expect(isRemoteOf("https://github.com/artemisrec/prodi", "artemisrec/odi")).toBe(false);
    expect(isRemoteOf("https://github.com/other/odi", "artemisrec/odi")).toBe(false);
  });
});

describe("finding a project's checkout", () => {
  const home = mkdtempSync(join(tmpdir(), "sentry-checkout-"));
  afterAll(() => rmSync(home, { recursive: true, force: true }));

  function checkout(folder: string, url: string): void {
    mkdirSync(join(home, folder, ".git"), { recursive: true });
    writeFileSync(
      join(home, folder, ".git", "config"),
      `[core]\n\tbare = false\n[remote "origin"]\n\turl = ${url}\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n`,
    );
  }

  checkout("src/odi-main", "git@github.com:artemisrec/odi.git");
  checkout("code/web", "https://github.com/artemisrec/unrelated");
  // Somewhere the scan never looks, known only because a session runs there.
  checkout("deep/away/shop", "https://github.com/artemisrec/shop");
  mkdirSync(join(home, "deep", "away", "shop", "backend"), { recursive: true });
  // A linked worktree of it: its .git is a file pointing into the main one.
  mkdirSync(join(home, "wt", "shop-fix"), { recursive: true });
  writeFileSync(
    join(home, "wt", "shop-fix", ".git"),
    `gitdir: ${join(home, "deep", "away", "shop", ".git", "worktrees", "shop-fix")}\n`,
  );

  const odi = [mapping("artemisrec/odi")];
  const shop = [mapping("artemisrec/shop", { project: "shop" })];
  const none = { pinned: {}, remembered: {}, sessionFolders: [], home };

  test("a folder named differently from the repo is found by its remote", () => {
    expect(findCheckout("artemisrec/odi", home)).toBe(join(home, "src", "odi-main"));
    expect(checkoutFor("odi", odi, none)).toEqual({
      repo: "artemisrec/odi",
      folder: join(home, "src", "odi-main"),
    });
  });

  test("a worktree or a subfolder leads back to its main checkout", () => {
    const main = join(home, "deep", "away", "shop");
    expect(mainCheckout(join(home, "wt", "shop-fix"))).toBe(main);
    expect(mainCheckout(join(main, "backend"))).toBe(main);
    expect(mainCheckout(tmpdir())).toBe("");
  });

  test("a checkout outside ~, ~/src and ~/code is found through a session running in it", () => {
    expect(checkoutFor("shop", shop, none).folder).toBe("");
    const clues = { ...none, sessionFolders: ["/nowhere", join(home, "wt", "shop-fix")] };
    expect(checkoutFor("shop", shop, clues).folder).toBe(join(home, "deep", "away", "shop"));
  });

  test("a folder pinned in the settings, then one remembered, win over everything found", () => {
    const pinned = { ...none, pinned: { odi: "/pinned" }, remembered: { odi: home } };
    expect(checkoutFor("odi", odi, pinned).folder).toBe("/pinned");
    expect(checkoutFor("odi", odi, { ...none, remembered: { odi: home } }).folder).toBe(home);
  });

  test("a remembered folder that is gone is passed over", () => {
    const gone = { ...none, remembered: { odi: join(home, "gone") } };
    expect(checkoutFor("odi", odi, gone).folder).toBe(join(home, "src", "odi-main"));
  });

  test("with no code mapping, a checkout named like the project; else nothing", () => {
    expect(checkoutFor("web", [], none)).toEqual({ repo: "", folder: join(home, "code", "web") });
    expect(checkoutFor("mobile", [], none)).toEqual({ repo: "", folder: "" });
  });

  test("a mapped repo not checked out anywhere leaves the folder to the reader", () => {
    const elsewhere = [mapping("artemisrec/nowhere", { project: "web" })];
    expect(checkoutFor("web", elsewhere, none)).toEqual({ repo: "artemisrec/nowhere", folder: "" });
  });
});
