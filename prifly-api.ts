/**
 * A copy of prifly's extension contract (apps/desktop-host/src/extensions/api.ts
 * in jimmy927/prifly), kept here so this extension type-checks on its own.
 *
 * What an extension is given, and what it gives back — the whole contract.
 *
 * An extension is a folder with a `prifly-extension.json` manifest and a
 * TypeScript or JavaScript module the host imports:
 *
 *     { "id": "vastai", "name": "Vast.ai boxes", "main": "index.ts",
 *       "description": "…", "version": "0.1.0" }
 *
 * Python tools come from a `pyproject.toml` and `uv.lock` beside it: prifly
 * builds the extension's `.venv` before starting it (`python.ts`).
 *
 * The module exports `activate(api)`, which may return a function the host
 * calls to stop it. It runs inside the host, with the host's rights: enable
 * only extensions you would run yourself.
 */

export type DecorationTone = "good" | "warning" | "critical" | "info" | "muted";

/** A launcher button's glow: its colour, and a line for its hover ("3 open errors"). */
export type LauncherFlag = { tone: DecorationTone; hint?: string };

/** One of the icons the window has: see `DECORATION_ICONS` in `@prifly/wire`. */
export type DecorationIcon =
  | "server"
  | "cpu"
  | "gpu"
  | "hard-drive"
  | "cloud"
  | "box"
  | "zap"
  | "activity"
  | "dollar"
  | "clock"
  | "alert"
  | "check"
  | "link"
  | "chart"
  | "bug"
  | "bug-off"
  | "sentry"
  | "dot";

/** One item in a chip's own menu: "Move to Doing" on a Trello card. */
/** One item in a chip's menu: "Move to Doing" on a Trello card, "Destroy box…" on a Vast.ai one. */
export type DecorationAction = {
  id: string;
  /** The menu's words: "Destroy box…". */
  label: string;
  /** Asked before it runs: what it will do and what is lost. */
  confirm?: string | undefined;
  /** Drawn in the danger colour. */
  destructive?: boolean | undefined;
  /**
   * What the reader picks before it runs. `"session"` opens prifly's session
   * picker — every session, ended and archived ones too, searchable — and the
   * action handler is called with the chosen one as its third argument.
   * Cancelling the picker calls nothing.
   */
  pick?: "session" | undefined;
};

/** What the reader picked for an action with `pick` set; see `DecorationAction.pick`. */
export type ActionPicked = { sessionId: string };

export type Decoration = {
  /** Stable within the extension, so the window keeps an item's place. */
  key: string;
  icon: DecorationIcon;
  /** A few words: "lc-box1 $0.42/h". */
  label: string;
  tone: DecorationTone;
  /** Shown on hover, one line each. */
  details: string[];
  /**
   * What a click on the item opens: a program in a terminal window of
   * prifly's own — `ssh` to a Vast.ai box. Run without a shell, as the reader.
   */
  terminal?: { title: string; command: string[] } | undefined;
  /** Where clicking the chip leads, in the reader's browser; left out, nowhere. */
  url?: string;
  /**
   * The item's menu, from its ▾ and from a right-click. Choosing one calls
   * the module's `action` export, or the handler given to `api.onAction`,
   * with the item's key and the action's id — after asking the reader
   * `confirm`, when it is not "".
   */
  actions?: DecorationAction[] | undefined;
};

/** A column of a board, in the order the board has them. */
export type LaunchColumn = { id: string; name: string };

/** The colours a label may wear; see `LABEL_COLOURS` in `@prifly/wire`. */
export type LabelColour =
  | "red"
  | "orange"
  | "yellow"
  | "green"
  | "blue"
  | "purple"
  | "pink"
  | "grey";

/** What an item says about itself at a glance. */
export type LaunchBadges = {
  comments?: number;
  attachments?: number;
  checklistDone?: number;
  checklistTotal?: number;
  /** A date written as the extension would have it read — "24 Sep" — or "". */
  due?: string;
  dueDone?: boolean;
  dueLate?: boolean;
};

/** How often it happened over one period, as bars, oldest first. */
export type LaunchSpark = {
  /** Its name on the board's period switch: "1h", "24h", "7d". */
  period: string;
  counts: number[];
  /** Everything in the period, for the words beside the bars. */
  total?: number;
};

/** One thing a launcher can start a session from: a card, an issue, a ticket. */
export type LaunchChoice = {
  /** The extension's own name for it; handed back when the reader picks it. */
  key: string;
  title: string;
  /** What it is filed under, drawn as a column: a board's list. */
  group?: string;
  /** A line under the title: who is on it, when it is due. */
  detail?: string;
  /** Where it comes from, in code type, right under the title: a culprit. */
  sub?: string;
  /** How often it happened, one per period; the board switches between them. */
  sparks?: LaunchSpark[];
  tone?: DecorationTone;
  /** Picking it asks this first; what is typed reaches `launch` as `input`. */
  input?: { title: string; placeholder?: string };
  /** Where it lives, for the reader's own browser. */
  url?: string;
  /** Label colours, drawn as stripes across the top of the card. */
  stripes?: LabelColour[];
  /** What its right-click menu offers; answered by this module's `action`. */
  actions?: DecorationAction[];
  /** Who is on it; the window draws initials. */
  people?: string[];
  badges?: LaunchBadges;
  /** A session was already started from it; the board tints the card. */
  started?: boolean;
};

/**
 * What a launcher offers, as a board: the columns, and the items in them.
 * An extension that answers with a plain array has no columns, and the window
 * draws a list — which is what a launcher still being set up should give.
 * Only a board gets the filter field over it: a list of log-in steps has
 * nothing in it to search.
 */
export type LaunchBoard = {
  columns: LaunchColumn[];
  items: LaunchChoice[];
  /** Things to do to the launcher itself: "Switch board…", "Log out". */
  actions?: LaunchChoice[];
};

/** A file on an item: a picture to look at, or something to fetch elsewhere. */
export type LaunchItemFile = {
  /** This extension's own name for it, so two files called image.png are two. */
  id?: string;
  name: string;
  url?: string;
  /** The picture itself, as a `data:` URI, when it could be fetched. */
  data?: string;
  at?: string;
};

/** One thing somebody said on an item, oldest first. Markdown. */
export type LaunchItemNote = { by: string; at?: string; text: string };

/**
 * One item, read whole.
 *
 * The prose is Markdown; what is not prose — where it sits, who is on it,
 * what is attached, what has been said — is kept apart, so the window can lay
 * a ticket out as a ticket rather than as a page of text.
 */
export type LaunchItem = {
  title: string;
  url?: string;
  /** The column it sits in now, by id, and what that column is called. */
  column?: string;
  columnName?: string;
  labels?: { colour: LabelColour; name: string }[];
  people?: string[];
  due?: string;
  dueLate?: boolean;
  /** The description. */
  markdown: string;
  /** Checklists, as `- [x]` task lists under their own headings. */
  checklists?: string;
  files?: LaunchItemFile[];
  notes?: LaunchItemNote[];
};

/**
 * What a chosen thing becomes: the New session form, filled in — or, with an
 * empty prompt, nothing at all. An empty one leaves the chooser open, says
 * `message` and lists again, which is how a row can log the reader in or
 * choose which board to show instead of starting a session.
 */
export type Launch = {
  /** The session's first prompt — everything it needs to start. */
  prompt: string;
  /** Where to work; left out, the reader chooses as usual. */
  cwd?: string;
  /** A suggested name for the session and its worktree. */
  name?: string;
  /** A line for the chooser, whether or not a session follows. */
  message?: string;
  /**
   * Pictures for the session's opening message — the screenshots on the card,
   * carried into the first turn rather than left as paths to open. png, jpeg,
   * gif or webp, base64, at most twenty.
   */
  images?: { mediaType: "image/png" | "image/jpeg" | "image/gif" | "image/webp"; data: string }[];
};

/** A setting's value: a boolean, number, string, or the ticked options of a "choices" field. */
export type SettingValue = boolean | number | string | string[];

/** How `api.start` went: the session it made, or why none was. */
export type StartAnswer = { started: true; sessionId: string } | { started: false; reason: string };

/** A session the host knows, for an extension to match its things against. */
export type ExtensionSession = { id: string; title: string; cwd: string; state: string };

/** What `api.vault.file` asks of the reader; the token never comes back. */
export type VaultFileRequest = {
  token: string;
  label?: string | undefined;
  host?: string | undefined;
  why: string;
};

/** How the reader answered the vault card, or why none was shown. */
export type VaultFileResult =
  | { outcome: "accepted"; level: 1 | 2 | 4 }
  | { outcome: "declined" }
  | { outcome: "timed out" }
  | { outcome: "refused"; message: string };

/**
 * The vault entries this extension's manifest names under `vault`.
 * `read` is on any prifly with a vault; `file` and `forget` only where
 * `features` includes "vault-file".
 */
export type ExtensionVaultApi = {
  /** An `api-token` entry's token, or null (no entry, not level 1, not in the manifest). */
  read(name: string): Promise<string | null>;
  /** Asks the reader to file `token` as the entry `name`; resolves once they answer. */
  file?(name: string, request: VaultFileRequest): Promise<VaultFileResult>;
  /** Log out: removes an entry this extension filed; true when it did. */
  forget?(name: string): Promise<boolean>;
};

export type ExtensionApi = {
  /**
   * What this prifly accepts beyond the first version, by name — "start-session"
   * among them where `start` exists. Absent on a prifly that predates the list.
   */
  features?: readonly string[];
  /** The vault entries the manifest's `vault` list names. Absent on a prifly without one. */
  vault?: ExtensionVaultApi;
  /**
   * Open `url` in the reader's own browser (on Windows, the Windows one, also
   * when prifly's host runs in WSL). Only http and https are opened. The
   * answer says whether a browser opened. Only where `features` includes
   * "open-url".
   */
  openUrl?(url: string): Promise<boolean>;
  /**
   * Replace everything this extension shows. `bySession` is keyed by a
   * session id or any unique start of one (a label has room for 8 characters);
   * items for an id no session has, and `unclaimed`, go to the status bar.
   */
  show(bySession: Record<string, Decoration[]>, unclaimed: Decoration[]): void;
  /**
   * Make the launcher `launchId`'s button glow in `tone`'s colour, `hint`
   * added to its hover — something waiting behind it, such as open errors.
   * Null puts it out. Missing from a prifly older than the call.
   */
  flag?(launchId: string, flag: LauncherFlag | null): void;
  /**
   * Carry out an action the reader chose from an item's right-click menu.
   * What it returns is shown to them ("Destroyed lc-box1"); what it throws is
   * shown as the failure. One handler per extension; a second call replaces it.
   */
  onAction(
    handler: (key: string, action: string, picked?: ActionPicked) => Promise<string> | string,
  ): void;
  /**
   * Start a session from one of this extension's launcher items by itself,
   * exactly as pressing Start on it would: `launch()` gives the prompt and
   * folder, the first message goes as Research, and `launched` is told which
   * session it became. Only for a launcher whose manifest entry says
   * `"starts": true`, and under prifly's caps: three of this extension's
   * starts running at once, twelve an hour. Only where `features` includes
   * "start-session".
   */
  start?(launchId: string, key: string): Promise<StartAnswer>;
  /**
   * The values of the settings the manifest declares under `settings`, as
   * the reader set them on the Extensions page, defaults filled in. Only
   * where `features` includes "settings".
   */
  settings?: Readonly<Record<string, SettingValue>>;
  /** Called with every value after the reader changes one. One handler; a second call replaces it. */
  onSettings?(handler: (values: Readonly<Record<string, SettingValue>>) => void): void;
  /**
   * What the extension keeps for itself, in prifly's database: JSON
   * documents and append-only logs, moving with prifly's data. Only where
   * `features` includes "state".
   */
  state?: ExtensionStateApi;
  /** The sessions on this machine the host knows now. */
  sessions(): ExtensionSession[];
  /** A line in the host's log, under `ext.<id>.<event>`. */
  log(event: string, fields?: Record<string, string | number | boolean | null>): void;
  /** The extension's own folder: where it keeps its config. */
  folder: string;
  /**
   * The folders its programs are in, first on the PATH of every session
   * prifly runs: its manifest's `bin`, and the `bin` of the `.venv` prifly
   * builds from its `pyproject.toml` and `uv.lock` (prifly brings uv and the
   * Python; the extension ships neither).
   */
  paths: readonly string[];
};

export type ExtensionModule = {
  activate: (api: ExtensionApi) => (() => void) | undefined | Promise<(() => void) | undefined>;
  /**
   * What the launcher `launchId` offers now, narrowed by what the reader has
   * typed. Called on every keystroke's worth of typing, so answer from what is
   * already in hand rather than asking the network each time.
   */
  choices?: (
    launchId: string,
    query: string,
  ) => LaunchChoice[] | LaunchBoard | Promise<LaunchChoice[] | LaunchBoard>;
  /** One item, written out: its text, its conversation, its pictures. */
  open?: (launchId: string, key: string) => LaunchItem | Promise<LaunchItem>;
  /** An item dragged into another column, by that column's `id`. */
  move?: (launchId: string, key: string, column: string) => void | Promise<void>;
  /**
   * The chosen one, as a session would start from it, with what was typed into
   * its row. `again` is true when the reader asked for it from a session that
   * was already started from this item — another one, on purpose.
   */
  launch?: (
    launchId: string,
    key: string,
    input: string,
    how: { again: boolean },
  ) => Launch | Promise<Launch>;
  /**
   * The session that launch became, once it is running — where a card learns
   * which session is its. Only for a launch the reader went through with.
   */
  launched?: (launchId: string, key: string, sessionId: string) => void | Promise<void>;
  /**
   * An item from a chip's or a board card's menu, by its `key`; what it
   * returns is said to the reader. `picked` is the session the reader chose,
   * for an action with `pick: "session"`.
   */
  action?: (
    key: string,
    actionId: string,
    picked?: ActionPicked,
  ) => string | undefined | Promise<string | undefined>;
};

/** `api.state`, as prifly's `state.ts` declares it. Absent on an older prifly: check `features` for "state". */
export type ExtensionStateApi = {
  /** The document `name`, or undefined when there is none. `T` is what the caller says it is, unchecked. */
  get<T = unknown>(name: string): Promise<NoInfer<T> | undefined>;
  /** Replace the document `name` with `value`, in one write. */
  set(name: string, value: unknown): Promise<void>;
  /**
   * Read the document, give it to `fn` (undefined when there is none), and
   * store what `fn` returns. Writes to one name run one at a time, so two
   * updates never lose each other's change. Never await a write to the same
   * name inside `fn`.
   */
  update<T>(name: string, fn: (current: T | undefined) => T | Promise<T>): Promise<T>;
  /** Remove the document `name`; true when there was one. */
  delete(name: string): Promise<boolean>;
  /** The names of this extension's documents, sorted. */
  list(): Promise<string[]>;
  /**
   * Bring state in from somewhere else once: when the document `name`
   * exists it is returned and `make` is not called; otherwise `make`'s value
   * is stored and returned, and undefined from `make` stores nothing.
   */
  importOnce<T>(
    name: string,
    make: () => T | undefined | Promise<T | undefined>,
  ): Promise<T | undefined>;
  /** Add `entry` to the end of the log `name`; resolves to its `seq`. */
  append(name: string, entry: unknown): Promise<number>;
  /** The log `name`'s entries, oldest first. */
  read<T = unknown>(
    name: string,
    options?: { after?: number; since?: number; limit?: number },
  ): Promise<{ seq: number; at: number; entry: NoInfer<T> }[]>;
};
