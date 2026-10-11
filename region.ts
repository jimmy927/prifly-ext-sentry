/**
 * Which server an organization's calls go to. Sentry's hosted service keeps
 * each organization in a data region (`https://de.sentry.io` for the EU,
 * `https://us.sentry.io` for the US); the organization list says which. A
 * self-hosted Sentry has no regions: its Base URL is used as it is.
 */

import { hasState, parseChoices } from "./choices";
import { type Creds, organizations } from "./sentry";
import type { World } from "./world";

/** Sentry's own address; with this as the Base URL, an organization is reached in its data region. */
export const DEFAULT_BASE_URL = "https://sentry.io";

/**
 * Where the chosen organization's data is: a self-hosted Base URL always; with
 * the default sentry.io, the organization's data region once it is known,
 * else sentry.io itself.
 */
export function apiBase(world: World): string {
  const { baseUrl, org } = world.config;
  if (baseUrl !== DEFAULT_BASE_URL) return baseUrl;
  return world.choices.regions?.[org] ?? baseUrl;
}

/** The token and the server for calls inside the chosen organization. */
export function orgCreds(world: World): Creds | null {
  return world.login === null ? null : { baseUrl: apiBase(world), token: world.login.token };
}

/** Worlds whose organization region was already looked up, so a failed lookup is not repeated on every refresh. */
const looked = new WeakMap<World, Set<string>>();

/**
 * Makes sure the chosen organization's region is known and kept: looked up
 * once from Sentry's organization list when none is stored (an organization
 * chosen before regions were kept, or set on the Extensions page). Does
 * nothing for a self-hosted Base URL. Never throws: without a region the
 * calls go to sentry.io, which is right for US organizations.
 */
export async function ensureRegion(world: World): Promise<void> {
  const { baseUrl, org } = world.config;
  if (world.login === null || org === "" || baseUrl !== DEFAULT_BASE_URL) return;
  if (world.choices.regions?.[org] !== undefined) return;
  const tried = looked.get(world) ?? new Set<string>();
  looked.set(world, tried);
  if (tried.has(org)) return;
  tried.add(org);
  try {
    const found = (await organizations({ baseUrl, token: world.login.token })).find(
      (candidate) => candidate.slug === org,
    );
    if (found !== undefined && found.regionUrl !== "") {
      await keepRegion(world, org, found.regionUrl);
    }
  } catch (caught) {
    world.api.log("region_lookup_failed", {
      org,
      message: caught instanceof Error ? caught.message : String(caught),
    });
  }
}

/** The organization's region, in force now and kept in the `choices` document. */
async function keepRegion(world: World, org: string, regionUrl: string): Promise<void> {
  const store = world.api.state;
  if (store === undefined || !hasState(world.api)) {
    world.choices = { ...world.choices, regions: { ...world.choices.regions, [org]: regionUrl } };
    return;
  }
  const kept = await store.update<unknown>("choices", (current) => {
    const now = parseChoices(current);
    return { ...now, regions: { ...now.regions, [org]: regionUrl } };
  });
  world.choices = parseChoices(kept);
}
