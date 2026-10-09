import { parseCatalogue } from "./catalogue";
import type { GameEntry } from "./types";

/** Minimal response shape so tests can pass a fake fetch. */
export interface CatalogueResponse {
  ok: boolean;
  status?: number;
  json(): Promise<unknown>;
}

export type CatalogueFetch = (url: string) => Promise<CatalogueResponse>;

/**
 * Fetch and validate the static catalogue. Any invalid entry or non-ok
 * response throws, so a malformed deploy fails loudly instead of half-loading.
 */
export async function loadCatalogue(
  url: string,
  fetchImpl: CatalogueFetch = fetch,
): Promise<GameEntry[]> {
  const response = await fetchImpl(url);
  if (!response.ok) {
    throw new Error(`catalogue: fetch ${url} failed (${response.status ?? "?"})`);
  }
  return parseCatalogue(await response.json());
}
