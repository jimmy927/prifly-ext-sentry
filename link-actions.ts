import type { DecorationAction } from "./prifly-api";

/**
 * "Link to session…": prifly opens its session picker — every session,
 * searchable — and `action` gets the chosen one, so a session that was not
 * started from the issue can carry its chip.
 */
export const LINK_ACTION: DecorationAction = {
  id: "link",
  label: "Link to session…",
  pick: "session",
};

/** The issue's menu with the link row just before "Archive until it escalates", the destructive one. */
export function withLink<T extends { id: string }>(actions: readonly T[], link: T): T[] {
  const at = actions.findIndex((action) => action.id === "ignore");
  return at === -1 ? [...actions, link] : [...actions.slice(0, at), link, ...actions.slice(at)];
}
