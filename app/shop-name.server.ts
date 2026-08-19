/**
 * Resolving a shop's own name.
 *
 * Buyers see this. Their quote page is headed "From {store}" and the email that
 * sends them there is subject-lined "Your quote from {store} is ready", so the
 * value has to be the name the merchant actually trades under. Deriving it from
 * the domain gives the myshopify subdomain — "acme-coffee" for Acme Coffee
 * Roasters — which reads to a buyer like an internal code, or worse, like the
 * wrong shop.
 *
 * `Shop.name` is the shop's own name, and `query { shop { name } }` is the
 * canonical example query in the Admin API reference
 * (https://shopify.dev/docs/api/admin-graphql/2026-07). Like `currencyCode` and
 * `email`, the docs list no access scope for it.
 *
 * Cached in ShopSetting for exactly the reason the currency is
 * (see shop-currency.server.ts): the buyer-facing pages run on the app proxy,
 * where there is no admin request to authenticate, so every uncached read is a
 * live Admin call over the offline token that can fail for reasons the buyer
 * never sees and the merchant cannot fix. The cache turns that into a read of
 * our own database, and the live call becomes the fallback.
 *
 * Unlike the currency, a missing name is never a wrong number — it only costs
 * the buyer a nicer label — so every failure path here ends in `null` and the
 * caller falls back to the subdomain.
 */

import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";

import prisma from "./db.server";
import { unauthenticated } from "./shopify.server";

/**
 * How long a cached name is served without asking again.
 *
 * A shop renames itself about as often as it changes selling currency, so this
 * matches the currency's window: short enough to pick a change up the same day,
 * long enough that the buyer-facing pages almost never make a live call.
 */
const CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

const SHOP_NAME_QUERY = `#graphql
  query quoteCrateShopName {
    shop {
      name
    }
  }`;

type ShopNameResponse = {
  data?: { shop?: { name?: string | null } | null } | null;
};

/**
 * A name we would rather not show a buyer. Shopify returns `String!`, but an
 * empty or whitespace-only value would render as a blank "From " line, which is
 * worse than the subdomain fallback.
 */
function usable(name: string | null | undefined): string | null {
  const trimmed = name?.trim();
  return trimmed ? trimmed : null;
}

/**
 * One live read, over the passed admin context when there is one and over the
 * shop's stored offline token otherwise.
 *
 * The docs warn that `unauthenticated.admin` performs no validation and must not
 * be given raw user input. Callers without an admin context pass a shop domain
 * taken from an app proxy request, whose HMAC signature covers the query string,
 * so the value is already verified by the time it arrives here.
 */
async function readShopNameLive(
  shop: string,
  admin?: AdminApiContext,
): Promise<string | null> {
  try {
    const context = admin ?? (await unauthenticated.admin(shop)).admin;
    const response = await context.graphql(SHOP_NAME_QUERY);
    const json = (await response.json()) as ShopNameResponse;

    return usable(json?.data?.shop?.name);
  } catch (error) {
    // Everything is swallowed here, including the `Response` the library throws
    // when it wants re-authentication — which the currency lookup deliberately
    // rethrows. The difference is what the failure costs. A wrong currency is a
    // wrong number on an invoice, so it has to be loud; a missing shop name is
    // only a less friendly label, and the buyer's quote page runs on the app
    // proxy where a thrown Response would replace their quote with an error.
    // Never break a buyer's page over the heading on it.
    console.warn(
      `[quotecrate] Shop name lookup for ${shop} failed; falling back to the shop handle.`,
      error,
    );
    return null;
  }
}

async function rememberShopName(shop: string, name: string) {
  try {
    await prisma.shopSetting.updateMany({
      where: { shop },
      data: { name, nameUpdatedAt: new Date() },
    });
  } catch (error) {
    // The cache is an optimisation; failing to write it must not fail the
    // request that happened to refresh it.
    console.warn(
      `[quotecrate] Could not cache the shop name for ${shop}.`,
      error,
    );
  }
}

/**
 * The shop's name, from the cache when it is fresh and from Shopify otherwise,
 * writing every live answer back to the cache.
 *
 * A stale cached name is preferred over nothing: it was true the last time the
 * shop could be reached. Returns null only when the name has never been read
 * successfully for this shop — callers pair this with `storeName()`, which falls
 * back to the subdomain.
 *
 * Written with `updateMany` rather than an upsert on purpose: the row is created
 * and owned by the currency cache, which cannot store a placeholder currency, so
 * a shop whose currency has never been read has no row to hang a name on yet.
 * The next admin page load creates it and the name lands on the following read.
 */
export async function shopName(
  shop: string,
  { admin }: { admin?: AdminApiContext } = {},
): Promise<string | null> {
  let cached: { name: string | null; nameUpdatedAt: Date | null } | null = null;
  try {
    cached = await prisma.shopSetting.findUnique({
      where: { shop },
      select: { name: true, nameUpdatedAt: true },
    });
  } catch (error) {
    console.warn(
      `[quotecrate] Could not read the cached shop name for ${shop}.`,
      error,
    );
  }

  const cachedName = usable(cached?.name);

  if (
    cachedName &&
    cached?.nameUpdatedAt &&
    Date.now() - cached.nameUpdatedAt.getTime() < CACHE_MAX_AGE_MS
  ) {
    return cachedName;
  }

  const live = await readShopNameLive(shop, admin);
  if (live) {
    await rememberShopName(shop, live);
    return live;
  }

  if (cachedName) {
    console.warn(
      `[quotecrate] Serving the cached name for ${shop}; the live lookup failed.`,
    );
    return cachedName;
  }

  return null;
}
