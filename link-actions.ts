import type { DecorationAction, ExtensionSession } from "./prifly-api";

/** How many sessions an issue's menu offers to link to; more would be a list to scroll. */
export const MOST_LINKS = 4;

/** The menu id prefix; what follows it is the full session id. */
export const LINK_PREFIX = "link:";

/**
 * "Link to session: <title>" for the recent sessions an issue could be linked to.
 *
 * The host lists running and recent sessions first and older ones, marked
 * "ended", after them — so skipping the ended ones and keeping the list's
 * order is what "recent" means here. A session already on this issue is left
 * out: offering it would do nothing.
 */
export function linkActions(
  sessions: readonly ExtensionSession[],
  links: Readonly<Record<string, string>>,
  issue: string,
): DecorationAction[] {
  return sessions
    .filter((session) => session.state !== "ended" && links[session.id] !== issue)
    .slice(0, MOST_LINKS)
    .map((session) => ({
      id: `${LINK_PREFIX}${session.id}`,
      label: `Link to session: ${session.title}`,
    }));
}

/** The issue's menu with the link rows just before "Archive until it escalates", the destructive one. */
export function withLinks<T extends { id: string }>(
  actions: readonly T[],
  links: readonly T[],
): T[] {
  const at = actions.findIndex((action) => action.id === "ignore");
  return at === -1
    ? [...actions, ...links]
    : [...actions.slice(0, at), ...links, ...actions.slice(at)];
}
