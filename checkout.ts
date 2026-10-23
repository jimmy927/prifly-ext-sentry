/**
 * Which folder an issue's session starts in — worked out, never configured.
 *
 * Sentry knows which repository a project's code is in: its code mappings,
 * set up under the organization's GitHub (or GitLab…) integration. This
 * machine knows where that repository is checked out: a folder whose git
 * remote is that repository. So a project is followed from its slug to its
 * repo, and the repo to its checkout, in this order:
 *
 * 1. `projects` in `config.json`, for a reader who wants to pin one by hand;
 * 2. the folder the reader last started one of this project's sessions in
 *    (`state.json`'s `folders`, learned when a session starts);
 * 3. the checkout behind a folder a prifly session on this machine runs in;
 * 4. a checkout of the repo directly in `~`, `~/src` or `~/code`;
 * 5. without a code mapping, a checkout named like the project there.
 *
 * Found nowhere, the folder is left to prifly's New session form, and the
 * one the reader picks there is remembered for next time.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, normalize } from "node:path";
import type { CodeMapping } from "./sentry";

/** Where a project's sessions start, and how that was found; `folder` "" for nowhere. */
export type Checkout = { repo: string; folder: string };

export type Clues = {
  /** Sentry project slug → folder, from `config.json`. */
  pinned: Record<string, string>;
  /** Sentry project slug → the checkout its last session was started in. */
  remembered: Record<string, string>;
  /** The folders this machine's prifly sessions run in. */
  sessionFolders: string[];
  home?: string;
};

export function checkoutFor(slug: string, mappings: CodeMapping[], clues: Clues): Checkout {
  const home = clues.home ?? homedir();
  const repo = mainRepo(mappings, slug);
  const pinned = clues.pinned[slug];
  if (pinned !== undefined) return { repo, folder: pinned };
  const remembered = clues.remembered[slug];
  if (remembered !== undefined && existsSync(remembered)) return { repo, folder: remembered };
  if (repo === "") return { repo, folder: bySlug(slug, home) };
  for (const folder of clues.sessionFolders) {
    const top = mainCheckout(folder);
    if (top !== "" && isCheckoutOf(top, repo)) return { repo, folder: top };
  }
  return { repo, folder: findCheckout(repo, home) };
}

/**
 * The repo a project's code lives in, among its code mappings: one a person
 * set up before one Sentry made by itself, and one mapping the whole stack
 * (an empty stack root) before one for a single subfolder. "" when none.
 */
export function mainRepo(mappings: CodeMapping[], slug: string): string {
  const rank = (mapping: CodeMapping) =>
    (mapping.automatic ? 2 : 0) + (mapping.stackRoot === "" ? 0 : 1);
  const own = mappings.filter((mapping) => mapping.project === slug && mapping.repo !== "");
  own.sort((a, b) => rank(a) - rank(b));
  return own[0]?.repo ?? "";
}

/** The folders a checkout is looked for in: home itself, `~/src` and `~/code`. */
function roots(home: string): string[] {
  return [home, join(home, "src"), join(home, "code")];
}

/** `~/<slug>`, `~/src/<slug>` or `~/code/<slug>`, when it is a git checkout; "" when none. */
function bySlug(slug: string, home: string): string {
  const candidates = roots(home).map((root) => join(root, slug));
  return candidates.find((folder) => existsSync(join(folder, ".git"))) ?? "";
}

/** A checkout of `repo` (`owner/name`) directly inside `~`, `~/src` or `~/code`; "" when none. */
export function findCheckout(repo: string, home: string): string {
  const name = repo.split("/").pop() ?? "";
  for (const root of roots(home)) {
    // The folder named like the repo first, so a scan rarely has to happen.
    const named = join(root, name);
    if (name !== "" && isCheckoutOf(named, repo)) return named;
  }
  for (const root of roots(home)) {
    for (const entry of safeReaddir(root).sort()) {
      const folder = join(root, entry);
      if (isCheckoutOf(folder, repo)) return folder;
    }
  }
  return "";
}

/**
 * The main checkout a folder belongs to: the nearest folder up with a `.git`,
 * and for a linked worktree — whose `.git` is a file pointing into the main
 * checkout's `.git/worktrees/` — that main checkout. "" outside any.
 */
export function mainCheckout(folder: string): string {
  let at = folder;
  for (;;) {
    const git = join(at, ".git");
    const kind = kindOf(git);
    if (kind === "dir") return at;
    if (kind === "file") {
      const pointer = /^gitdir:\s*(.+?)\s*$/m.exec(readText(git))?.[1] ?? "";
      // git writes "/" even on Windows, but a hand-made pointer may use "\".
      const marker = /[\\/]\.git[\\/]worktrees[\\/]/.exec(pointer);
      return marker === null ? "" : normalize(pointer.slice(0, marker.index));
    }
    const up = dirname(at);
    if (up === at) return "";
    at = up;
  }
}

function kindOf(path: string): "dir" | "file" | "" {
  try {
    const found = statSync(path);
    return found.isDirectory() ? "dir" : found.isFile() ? "file" : "";
  } catch {
    return "";
  }
}

function readText(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

function safeReaddir(folder: string): string[] {
  try {
    return readdirSync(folder);
  } catch {
    return [];
  }
}

/**
 * Whether a folder is a main checkout with a remote that is `repo`. A
 * worktree's `.git` is a file, not a folder, so it has no config here: the
 * main checkout is the one found.
 */
function isCheckoutOf(folder: string, repo: string): boolean {
  const config = readText(join(folder, ".git", "config"));
  return [...config.matchAll(/^\s*url\s*=\s*(.+?)\s*$/gm)].some((match) =>
    isRemoteOf(match[1] ?? "", repo),
  );
}

/** Whether a remote URL — https, ssh or scp-style, `.git` or not — points at `owner/name`. */
export function isRemoteOf(url: string, repo: string): boolean {
  const path = url
    .toLowerCase()
    .replace(/\/+$/, "")
    .replace(/\.git$/, "");
  const want = repo.toLowerCase();
  return path.endsWith(`/${want}`) || path.endsWith(`:${want}`);
}
