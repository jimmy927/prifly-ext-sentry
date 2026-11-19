import type {
  ExtensionApi,
  ExtensionSecretsApi,
  ExtensionSession,
  SettingValue,
  VaultFileRequest,
  VaultFileResult,
} from "../prifly-api";
import { type FakeState, fakeState } from "./fake-state";

/** The three things this extension needs of a prifly: `supported` wants all of them. */
export type Needed = "settings" | "state" | "secrets";

export type FakePrifly = {
  api: ExtensionApi;
  /** prifly's database for the extension. */
  database: FakeState;
  /** The extension's own secrets, by key. */
  secrets: Map<string, string>;
  /** The vault's entries, by name: only an old login is ever in there. */
  entries: Map<string, string>;
  /** Every `api.vault.file` call: the extension must make none. */
  filed: { name: string; request: VaultFileRequest }[];
  forgotten: string[];
  logs: string[];
};

export type FakeOptions = {
  /** Features (and the api that goes with each) this prifly lacks. */
  without?: Needed[];
  /** A prifly with no vault at all. */
  noVault?: boolean;
  /** False for a vault entry the reader made themselves, which `forget` cannot remove. */
  ownEntry?: boolean;
  settings?: Readonly<Record<string, SettingValue>>;
  /** Extra features this prifly offers, such as "start-session". */
  features?: string[];
  sessions?: ExtensionSession[];
  /** A database that outlives this api, as prifly's does across a restart. */
  database?: FakeState;
  /** Secrets that outlive this api, as prifly's do across a restart. */
  secrets?: Map<string, string>;
};

/** A prifly's api for one extension, in memory: settings, `api.state`, `api.secrets` and the vault. */
export function fakePrifly(folder: string, options: FakeOptions = {}): FakePrifly {
  const lacks = new Set<Needed>(options.without ?? []);
  const database = options.database ?? fakeState();
  const secrets = options.secrets ?? new Map<string, string>();
  const entries = new Map<string, string>();
  const filed: FakePrifly["filed"] = [];
  const forgotten: string[] = [];
  const logs: string[] = [];
  const secretsApi: ExtensionSecretsApi = {
    get: async (key) => secrets.get(key) ?? null,
    set: async (key, value) => {
      if (value === null) secrets.delete(key);
      else secrets.set(key, value);
    },
    keys: async (prefix = "") => [...secrets.keys()].filter((key) => key.startsWith(prefix)).sort(),
  };
  const vault = options.noVault
    ? undefined
    : {
        read: async (name: string) => entries.get(name) ?? null,
        file: async (name: string, request: VaultFileRequest): Promise<VaultFileResult> => {
          filed.push({ name, request });
          entries.set(name, request.token);
          return { outcome: "accepted", level: 1 };
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
      ...(["settings", "state", "secrets"] as const).filter((feature) => !lacks.has(feature)),
      ...(options.noVault ? [] : ["vault-file"]),
      ...(options.features ?? []),
    ],
    log: (event: string, fields?: Record<string, unknown>) =>
      logs.push(`${event} ${JSON.stringify(fields ?? {})}`),
    show: () => undefined,
    onAction: () => undefined,
    sessions: () => options.sessions ?? [],
    ...(vault === undefined ? {} : { vault }),
    ...(lacks.has("secrets") ? {} : { secrets: secretsApi }),
    ...(lacks.has("settings") ? {} : { settings: options.settings ?? {} }),
    ...(lacks.has("state") ? {} : { state: database }),
  } as unknown as ExtensionApi;
  return { api, database, secrets, entries, filed, forgotten, logs };
}
