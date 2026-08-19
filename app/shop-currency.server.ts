/**
 * Resolving a shop's own currency.
 *
 * Quotes must be denominated in the currency the shop actually sells in:
 * the merchant types prices in it, the buyer is invoiced in it, and
 * `draftOrderCreate`'s `priceOverride` is interpreted in it. Hardcoding USD
 * only works for USD shops.
 *
 * `Shop.currencyCode` is `CurrencyCode!` — "The three letter code for the
 * currency that the shop sells in."
 * https://shopify.dev/docs/api/admin-graphql/2026-07/objects/Shop
 *
 * The storefront quote-request endpoint has no admin request to authenticate,
 * so it can only ask Shopify over the offline token — a live network call that
 * can fail for reasons the shopper never sees and the merchant cannot fix. A
 * failed lookup used to mean the quote was silently written as USD, which on a
 * KRW shop is a wrong number with no way to correct it. So the answer is cached
 * in ShopSetting and refreshed from the admin side, where an authenticated
 * context already exists, and the live call becomes the fallback rather than
 * the primary path.
 */

import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";

import prisma from "./db.server";
import { unauthenticated } from "./shopify.server";

/**
 * Used only when the shop's real currency has never once been read — no cache,
 * no live answer. It matches the Quote.currency column default, and a quote
 * created under it is repaired by `adoptShopCurrency` before anyone can price
 * it, so it is a placeholder rather than a decision.
 */
export const FALLBACK_CURRENCY = "USD";

/**
 * How long a cached currency is served without asking again. A shop's selling
 * currency is a setting that changes approximately never, so this only has to
 * be short enough that a change is picked up the same day.
 */
const CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/** One quick retry, for the case where the first call lost a race with a blip. */
const RETRY_DELAY_MS = 300;

const SHOP_CURRENCY_QUERY = `#graphql
  query quoteCrateShopCurrency {
    shop {
      currencyCode
    }
  }`;

type ShopCurrencyResponse = {
  data?: { shop?: { currencyCode?: string | null } | null } | null;
};

/**
 * Read the shop currency using an already-authenticated admin context.
 *
 * Deliberately uncached: `convertQuoteToDraftOrder` uses this as its final
 * check that the quote's currency is still the one the buyer will be billed in,
 * and that check is worthless if it can be answered from a day-old row.
 */
export async function getShopCurrency(
  admin: AdminApiContext,
): Promise<string | null> {
  const response = await admin.graphql(SHOP_CURRENCY_QUERY);
  const json = (await response.json()) as ShopCurrencyResponse;

  return json?.data?.shop?.currencyCode ?? null;
}

const sleep = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

/**
 * One live read, over the passed admin context when there is one and over the
 * shop's stored offline token otherwise, retried once.
 *
 * The docs warn that `unauthenticated.admin` performs no validation and must
 * not be given raw user input. Callers without an admin context pass a shop
 * domain taken from an app proxy request, whose HMAC signature covers the query
 * string, so the value is already verified by the time it arrives here.
 */
async function readShopCurrencyLive(
  shop: string,
  admin?: AdminApiContext,
): Promise<string | null> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const context = admin ?? (await unauthenticated.admin(shop)).admin;
      const currency = await getShopCurrency(context);
      if (currency) return currency;
    } catch (error) {
      // A thrown Response is the library asking for re-authentication, which
      // only an admin request can act on; never swallow it into a null.
      if (error instanceof Response) throw error;

      console.warn(
        `[quotecrate] Shop currency lookup for ${shop} failed (attempt ${
          attempt + 1
        }).`,
        error,
      );
    }

    if (attempt === 0) await sleep(RETRY_DELAY_MS);
  }

  return null;
}

async function rememberShopCurrency(shop: string, currency: string) {
  try {
    await prisma.shopSetting.upsert({
      where: { shop },
      create: { shop, currency, currencyUpdatedAt: new Date() },
      update: { currency, currencyUpdatedAt: new Date() },
    });
  } catch (error) {
    // The cache is an optimisation; failing to write it must not fail the
    // request that happened to refresh it.
    console.warn(
      `[quotecrate] Could not cache the shop currency for ${shop}.`,
      error,
    );
  }
}

/**
 * The shop's selling currency, from the cache when it is fresh and from
 * Shopify otherwise, writing every live answer back to the cache.
 *
 * A stale cached value is preferred over nothing: it was true the last time the
 * shop could be reached, which beats inventing a default. Returns null only
 * when the currency has never been read successfully for this shop.
 */
export async function shopCurrency(
  shop: string,
  { admin }: { admin?: AdminApiContext } = {},
): Promise<string | null> {
  let cached: { currency: string; currencyUpdatedAt: Date } | null = null;
  try {
    // Freshness comes from `currencyUpdatedAt`, not the row's `updatedAt`: the
    // row also caches the shop name now, and `@updatedAt` bumps on any write, so
    // reading the row's timestamp would let a name refresh mark the currency
    // fresh and stop it from ever being re-read.
    cached = await prisma.shopSetting.findUnique({
      where: { shop },
      select: { currency: true, currencyUpdatedAt: true },
    });
  } catch (error) {
    console.warn(
      `[quotecrate] Could not read the cached shop currency for ${shop}.`,
      error,
    );
  }

  if (
    cached &&
    Date.now() - cached.currencyUpdatedAt.getTime() < CACHE_MAX_AGE_MS
  ) {
    return cached.currency;
  }

  const live = await readShopCurrencyLive(shop, admin);
  if (live) {
    await rememberShopCurrency(shop, live);
    return live;
  }

  if (cached) {
    console.warn(
      `[quotecrate] Serving the cached ${cached.currency} currency for ${shop}; the live lookup failed.`,
    );
    return cached.currency;
  }

  console.error(
    `[quotecrate] The selling currency for ${shop} is unknown — no cached value and the live lookup failed.`,
  );
  return null;
}

/** What a quote looks like to `adoptShopCurrency`. */
type CurrencyAdoptable = {
  id: string;
  shop: string;
  status: string;
  currency: string;
  quotedTotalMinor: bigint | number | null;
  items: { quotedUnitPriceMinor: bigint | number | null }[];
};

/**
 * Re-stamp an unpriced quote with the shop's real currency.
 *
 * This is what stops a currency lookup failure from becoming a permanent wrong
 * number. A REQUESTED quote with no prices on it holds no money at all, so its
 * currency is a label and nothing else — changing it converts nothing and
 * loses nothing. The merchant's first visit to the quote is the last moment
 * before any amount is typed, so healing it there means a price is only ever
 * entered against a currency that was actually confirmed.
 *
 * A quote that already carries prices is deliberately left alone: re-labelling
 * "10000" from USD to KRW would change what the buyer is asked to pay. Those
 * surface as a visible mismatch warning instead.
 */
export async function adoptShopCurrency<T extends CurrencyAdoptable>(
  quote: T,
  currency: string | null,
): Promise<T> {
  if (!currency || quote.currency === currency) return quote;
  if (quote.status !== "REQUESTED") return quote;
  if (quote.quotedTotalMinor !== null) return quote;
  if (quote.items.some((item) => item.quotedUnitPriceMinor !== null)) {
    return quote;
  }

  // Conditional on the state that made this safe, so a send landing at the same
  // moment cannot have its currency changed out from under it.
  const adopted = await prisma.quote.updateMany({
    where: {
      id: quote.id,
      shop: quote.shop,
      status: "REQUESTED",
      quotedTotalMinor: null,
    },
    data: { currency },
  });

  if (adopted.count === 0) return quote;

  console.warn(
    `[quotecrate] Quote ${quote.id} was created as ${quote.currency} and has been corrected to the shop's ${currency}.`,
  );

  return { ...quote, currency };
}
