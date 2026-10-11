/**
 * What the reader picked in the chooser, as kept in `api.state`'s `choices`
 * document: the organization and sort, and each organization's data region.
 */

import type { ExtensionApi } from "./prifly-api";
import { obj } from "./read";

/** Whether this prifly keeps extension state in its database (`api.state`). */
export function hasState(api: ExtensionApi): boolean {
  return (api.features ?? []).includes("state") && api.state !== undefined;
}

/**
 * A choice made in the chooser: the `value` picked, and `over`, what the
 * setting held when it was picked. The choice stands while the setting still
 * holds that; once the reader changes the setting on the Extensions page, the
 * setting wins again.
 */
export type Choice = { value: string; over: string };
export type Choices = {
  org?: Choice;
  sort?: Choice;
  /**
   * Organization slug → the data region that hosts it (`https://de.sentry.io`),
   * from Sentry's organization list. Kept per slug, so it holds whether the
   * organization came from the chooser or from the Extensions page.
   */
  regions?: Record<string, string>;
};

export const CHOICE_KEYS = ["org", "sort"] as const;

export function parseChoices(raw: unknown): Choices {
  const choices: Choices = {};
  const regions: Record<string, string> = {};
  for (const [org, url] of Object.entries(obj(obj(raw)["regions"]))) {
    if (typeof url === "string" && url !== "") regions[org] = url;
  }
  if (Object.keys(regions).length > 0) choices.regions = regions;
  for (const key of CHOICE_KEYS) {
    const choice = obj(obj(raw)[key]);
    if (typeof choice["value"] === "string" && typeof choice["over"] === "string") {
      choices[key] = { value: choice["value"], over: choice["over"] };
    }
  }
  return choices;
}
