import type {
  ExtensionApi,
  ExtensionSession,
  SettingValue,
  VaultFileRequest,
  VaultFileResult,
} from "../prifly-api";
import { type FakeState, fakeState } from "./fake-state";

/** The three things this extension needs of a prifly: `supported` wants all of them. */
export type Needed = "settings" | "state" | "vault-file";

export type FakePrifly = {
  api: ExtensionApi;
  /** prifly's database for the extension. */
  database: FakeState;
  /** The vault's entries, by name. */
  entries: Map<string, string>;
  filed: { name: string; request: VaultFileRequest }[];
  forgotten: string[];
  logs: string[];
  /** Set during a test: the level the reader files at (anything but 1 makes `read` answer null) and a card held open. */
  control: { level: 1 | 2 | 4; gate: Promise<void> | null };
};

export type FakeOptions = {
  /** Features (and the api that goes with each) this prifly lacks. */
  without?: Needed[];
  /** What the reader answers on the vault's card. */
  answer?: VaultFileResult["outcome"];
  /** False for an entry the reader made themselves, which `forget` cannot remove. */
  ownEntry?: boolean;
  settings?: Readonly<Record<string, SettingValue>>;
  /** Extra features this prifly offers, such as "start-session". */
  features?: string[];
  sessions?: ExtensionSession[];
  /** A database that outlives this api, as prifly's does across a restart. */
  database?: FakeState;
};

/** A prifly's api for one extension, in memory: settings, `api.state` and the vault. */
export function fakePrifly(folder: string, options: FakeOptions = {}): FakePrifly {
  const lacks = new Set<Needed>(options.without ?? []);
  const database = options.database ?? fakeState();
  const entries = new Map<string, string>();
  const filed: FakePrifly["filed"] = [];
  const forgotten: string[] = [];
  const logs: string[] = [];
  const control: FakePrifly["control"] = { level: 1, gate: null };
  const answer = options.answer ?? "accepted";
  const read = async (name: string) => (control.level === 1 ? (entries.get(name) ?? null) : null);
  const vault = lacks.has("vault-file")
    ? { read }
    : {
        read,
        file: async (name: string, request: VaultFileRequest): Promise<VaultFileResult> => {
          filed.push({ name, request });
          await control.gate;
          if (answer === "accepted") {
            entries.set(name, request.token);
            return { outcome: "accepted", level: control.level };
          }
          return answer === "refused"
            ? { outcome: "refused", message: "not listed" }
            : { outcome: answer };
        },
        forget: async (name: string) => {
          forgotten.push(name);
          if (options.ownEntry === false) return false;
          return entries.delete(name);
        },
      };
  const api = {
    folder,
    paths: [],
    features: [
      ...(["settings", "state", "vault-file"] as const).filter((feature) => !lacks.has(feature)),
      ...(options.features ?? []),
    ],
    log: (event: string, fields?: Record<string, unknown>) =>
      logs.push(`${event} ${JSON.stringify(fields ?? {})}`),
    show: () => undefined,
    onAction: () => undefined,
    sessions: () => options.sessions ?? [],
    vault,
    ...(lacks.has("settings") ? {} : { settings: options.settings ?? {} }),
    ...(lacks.has("state") ? {} : { state: database }),
  } as unknown as ExtensionApi;
  return { api, database, entries, filed, forgotten, logs, control };
}
