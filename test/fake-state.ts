import type { ExtensionStateApi } from "../prifly-api";

/**
 * prifly's `api.state` in memory, for the tests: documents are kept as JSON
 * text and handed back parsed afresh, as prifly does, and writes to a name
 * run one at a time in call order.
 */
export type FakeState = ExtensionStateApi & {
  /** The stored documents, as JSON text. */
  docs: Map<string, string>;
  /** How many writes (set, update, importOnce that stored) happened. */
  writes: () => number;
};

export function fakeState(): FakeState {
  const docs = new Map<string, string>();
  let writes = 0;
  let tail: Promise<unknown> = Promise.resolve();
  const read = <T>(name: string): T | undefined => {
    const text = docs.get(name);
    return text === undefined ? undefined : (JSON.parse(text) as T);
  };
  const store = (name: string, value: unknown): void => {
    docs.set(name, JSON.stringify(value));
    writes += 1;
  };
  const queued = <T>(task: () => Promise<T>): Promise<T> => {
    const run = tail.then(task);
    tail = run.catch(() => undefined);
    return run;
  };
  return {
    docs,
    writes: () => writes,
    get: async <T>(name: string) => read<T>(name),
    set: (name, value) =>
      queued(async () => {
        store(name, value);
      }),
    update: <T>(name: string, fn: (current: T | undefined) => T | Promise<T>) =>
      queued(async () => {
        const next = await fn(read<T>(name));
        if (next === undefined) throw new Error("update must return a value");
        store(name, next);
        return read<T>(name) as T;
      }),
    delete: (name) => queued(async () => docs.delete(name)),
    list: async () => [...docs.keys()].sort(),
    importOnce: <T>(name: string, make: () => T | undefined | Promise<T | undefined>) =>
      queued(async () => {
        if (docs.has(name)) return read<T>(name);
        const made = await make();
        if (made === undefined) return undefined;
        store(name, made);
        return read<T>(name);
      }),
    append: async () => 0,
    read: async () => [],
  };
}
