/**
 * Opening a Sentry page in the browser the reader actually uses.
 *
 * prifly's host runs where the projects are, which on Windows means inside
 * WSL, where there is usually no browser at all — the one they are signed in
 * to is the Windows one, so the URL is handed over the boundary. Never throws:
 * a page that would not open is not worth unwinding a step for, and the URL
 * is shown in the dialog to be copied.
 */

import { readFileSync } from "node:fs";

function isWsl(): boolean {
  if (process.platform !== "linux") return false;
  if (process.env["WSL_DISTRO_NAME"] !== undefined) return true;
  try {
    // WSL1 sets no variable at all; its kernel string is the only tell.
    return /microsoft/i.test(readFileSync("/proc/version", "utf8"));
  } catch {
    return false;
  }
}

/** Most specific first; `explorer.exe` exits 1 on URLs it opened perfectly well. */
function openers(url: string): { command: string[]; trustExitCode: boolean }[] {
  if (isWsl()) {
    return [
      { command: ["wslview", url], trustExitCode: true },
      { command: ["explorer.exe", url], trustExitCode: false },
    ];
  }
  if (process.platform === "darwin") return [{ command: ["open", url], trustExitCode: true }];
  if (process.platform === "win32") {
    // `start` takes the first quoted argument as a window title, and cmd
    // splits an unquoted `&` — which many URLs have.
    return [{ command: ["cmd", "/c", "start", "", `"${url}"`], trustExitCode: true }];
  }
  return [{ command: ["xdg-open", url], trustExitCode: true }];
}

export async function openBrowser(url: string): Promise<boolean> {
  for (const opener of openers(url)) {
    try {
      const child = Bun.spawn(opener.command, {
        stdin: "ignore",
        stdout: "ignore",
        stderr: "ignore",
      });
      const status = await child.exited;
      if (!opener.trustExitCode || status === 0) return true;
    } catch {
      // Not installed on this machine, which is the normal case for `wslview`
      // and the reason this is a list rather than one command.
    }
  }
  return false;
}
