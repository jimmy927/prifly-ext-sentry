import { describe, expect, test } from "bun:test";
import { copyFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const skillDir = join(import.meta.dir, "..", "skills", "sentry");

/** Runs `sentry.settings(None, json.loads(${JSON.stringify(JSON.stringify(base))}))` of the skill's script with the given database and environment. */
function settings(
  env: Record<string, string>,
  seed: string | null,
  base: string | null = null,
  rc: string | null = null,
) {
  const dir = mkdtempSync(join(tmpdir(), "sentry-skill-"));
  const db = join(dir, "prifly.db");
  // The script runs from a copy inside the temp dir, so the extension folder it
  // looks in for auth.json is empty, whatever the checkout the tests run in holds.
  const copied = join(dir, "ext", "skills", "sentry");
  mkdirSync(copied, { recursive: true });
  copyFileSync(join(skillDir, "sentry.py"), join(copied, "sentry.py"));
  if (rc !== null) writeFileSync(join(dir, ".sentryclirc"), rc);
  const script = `
import sqlite3, sys, json
sys.path.insert(0, ${JSON.stringify(copied)})
seed = json.loads(${JSON.stringify(JSON.stringify(seed))})
if seed is not None:
    con = sqlite3.connect(${JSON.stringify(db)})
    con.execute("create table settings (key text primary key, value text)")
    con.execute("insert into settings values ('prifly.extensions.settings.sentry', ?)", (seed,))
    con.commit(); con.close()
import sentry
print(json.dumps(sentry.settings(None, json.loads(${JSON.stringify(JSON.stringify(base))}))))
`;
  const run = Bun.spawnSync(["python3", "-c", script], {
    env: {
      PATH: Bun.env["PATH"] ?? "",
      HOME: dir,
      SENTRY_AUTH_TOKEN: "t",
      PRIFLY_DB: db,
      ...env,
    },
  });
  return { out: run.stdout.toString().trim(), err: run.stderr.toString() };
}

describe("the sentry skill's organization", () => {
  test("comes from prifly's settings row, after the environment", () => {
    const row = JSON.stringify({ org: "from-db", baseUrl: "https://sentry.example.com/" });
    expect(JSON.parse(settings({}, row).out)).toEqual([
      "https://sentry.example.com/api/0",
      "t",
      "from-db",
    ]);
    expect(
      JSON.parse(settings({ SENTRY_ORG: "env-org", SENTRY_URL: "https://e.io" }, row).out),
    ).toEqual(["https://e.io/api/0", "t", "env-org"]);
  });

  test("--base-url wins over the environment and the row", () => {
    const row = JSON.stringify({ org: "o", baseUrl: "https://row.io" });
    expect(
      JSON.parse(settings({ SENTRY_URL: "https://env.io" }, row, "https://flag.io").out),
    ).toEqual(["https://flag.io/api/0", "t", "o"]);
  });

  test("the default address in the row leaves ~/.sentryclirc's url in charge", () => {
    const row = JSON.stringify({ org: "o", baseUrl: "https://sentry.io" });
    const rc = "[defaults]\nurl=https://self.example\n";
    expect(JSON.parse(settings({}, row, null, rc).out)).toEqual([
      "https://self.example/api/0",
      "t",
      "o",
    ]);
  });

  test("the token is SENTRY_AUTH_TOKEN, or SENTRY_TOKEN as vault_run sets it for the entry sentry", () => {
    const row = JSON.stringify({ org: "o" });
    expect(JSON.parse(settings({ SENTRY_AUTH_TOKEN: "auth" }, row).out)[1]).toBe("auth");
    expect(JSON.parse(settings({ SENTRY_AUTH_TOKEN: "", SENTRY_TOKEN: "vault" }, row).out)[1]).toBe(
      "vault",
    );
    expect(
      JSON.parse(settings({ SENTRY_AUTH_TOKEN: "auth", SENTRY_TOKEN: "vault" }, row).out)[1],
    ).toBe("auth");
  });

  test("without any token it points at vault_run", () => {
    const row = JSON.stringify({ org: "o" });
    const err = settings({ SENTRY_AUTH_TOKEN: "" }, row).err;
    expect(err).toContain('vault_run tool, entry "sentry"');
  });

  test("an empty value, a missing row or database falls through", () => {
    expect(settings({}, JSON.stringify({ org: "  ", baseUrl: "" })).err).toContain(
      "no Sentry organization",
    );
    expect(settings({}, null).err).toContain("Extensions dialog");
    expect(JSON.parse(settings({ SENTRY_ORG: "e" }, "not json").out)).toEqual([
      "https://sentry.io/api/0",
      "t",
      "e",
    ]);
  });
});
