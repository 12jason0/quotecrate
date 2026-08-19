/**
 * The two facts about a shop that a buyer sees.
 *
 * 1. Its name. The quote page is headed "From {store}" and the email that sends
 *    them there is subject-lined "Your quote from {store} is ready", so the
 *    value has to be the name the merchant actually trades under. Deriving it
 *    from the domain gives the myshopify subdomain — "acme-coffee" for Acme
 *    Coffee Roasters — which reads to a buyer like an internal code, or worse,
 *    like the wrong shop.
 *
 * 2. Its storefront URL. Several states of the quote page tell the buyer to
 *    contact the store, and until this existed there was nothing on the page to
 *    contact it *with*. `shop { primaryDomain { url } }` is a public address the
 *    merchant already publishes, so linking to it discloses nothing.
 *
 *    Deliberately not `shop { email }`: that is the shop *account* address and
 *    is frequently the owner's personal mailbox. Publishing it to every buyer
 *    who opens a quote link would be a privacy leak the merchant never agreed
 *    to. If a merchant wants an email route, their storefront is where they
 *    advertise it.
 *
 * Both are read by one query and cached together under one timestamp, because
 * they are always wanted at the same moment. `Shop.name` and
 * `Shop.primaryDomain` (a `Domain`, whose `url` is `URL!`) are documented at
 * https://shopify.dev/docs/api/admin-graphql/2026-07/objects/Domain and neither
 * lists an access scope, same as `currencyCode` and `email`.
 *
 * Cached in ShopSetting for exactly the reason the currency is
 * (see shop-currency.server.ts): the buyer-facing pages run on the app proxy,
 * where there is no admin request to authenticate, so every uncached read is a
 * live Admin call over the offline token that can fail for reasons the buyer
 * never sees and the merchant cannot fix. The cache turns that into a read of
 * our own database, and the live call becomes the fallback.
 *
 * Nothing here is ever a wrong number — a missing name costs a nicer label, a
 * missing URL costs a link — so every failure path ends in nulls and the callers
 * degrade to plain text.
 */

import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";

import prisma from "./db.server";
import { unauthenticated } from "./shopify.server";

/**
 * How long a cached profile is served without asking again.
 *
 * A shop renames itself, or moves domain, about as often as it changes selling
 * currency, so this matches the currency's window: short enough to pick a change
 * up the same day, long enough that the buyer-facing pages almost never make a
 * live call.
 */
const CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

const SHOP_PROFILE_QUERY = `#graphql
  query quoteCrateShopProfile {
    shop {
      name
      primaryDomain {
        url
      }
    }
  }`;

type ShopProfileResponse = {
  data?: {
    shop?: {
      name?: string | null;
      primaryDomain?: { url?: string | null } | null;
    } | null;
  } | null;
};

/** What the buyer-facing surfaces get. Either field can be null. */
export type ShopProfile = {
  name: string | null;
  url: string | null;
};

const EMPTY: ShopProfile = { name: null, url: null };

/**
 * Blank-ish values are treated as absent. Shopify types both fields non-null,
 * but an empty string would render as a blank "From " line or an href to
 * nowhere, either of which is worse than the fallback.
 */
function usable(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

/**
 * Only ever hand a buyer an ordinary web address.
 *
 * The URL comes from Shopify rather than from user input, so this is a
 * belt-and-braces check rather than a fix for a known hole: it keeps anything
 * that is not http(s) — a `javascript:` scheme above all — from reaching an
 * href on a page that anyone with a quote link can open.
 */
function safeUrl(value: string | null): string | null {
  if (!value) return null;

  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
    return parsed.toString();
  } catch {
    return null;
  }
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
async function readShopProfileLive(
  shop: string,
  admin?: AdminApiContext,
): Promise<ShopProfile> {
  try {
    const context = admin ?? (await unauthenticated.admin(shop)).admin;
    const response = await context.graphql(SHOP_PROFILE_QUERY);
    const json = (await response.json()) as ShopProfileResponse;

    return {
      name: usable(json?.data?.shop?.name),
      url: safeUrl(usable(json?.data?.shop?.primaryDomain?.url)),
    };
  } catch (error) {
    // Everything is swallowed here, including the `Response` the library throws
    // when it wants re-authentication — which the currency lookup deliberately
    // rethrows. The difference is what the failure costs. A wrong currency is a
    // wrong number on an invoice, so it has to be loud; a missing name or link
    // is only a plainer page, and the buyer's quote page runs on the app proxy
    // where a thrown Response would replace their quote with an error. Never
    // break a buyer's page over the heading on it.
    console.warn(
      `[quotecrate] Shop profile lookup for ${shop} failed; the buyer page falls back to the shop handle and drops the store link.`,
      error,
    );
    return EMPTY;
  }
}

async function rememberShopProfile(shop: string, profile: ShopProfile) {
  try {
    await prisma.shopSetting.updateMany({
      where: { shop },
      data: {
        name: profile.name,
        primaryDomainUrl: profile.url,
        profileUpdatedAt: new Date(),
      },
    });
  } catch (error) {
    // The cache is an optimisation; failing to write it must not fail the
    // request that happened to refresh it.
    console.warn(
      `[quotecrate] Could not cache the shop profile for ${shop}.`,
      error,
    );
  }
}

/**
 * The shop's name and storefront URL, from the cache when it is fresh and from
 * Shopify otherwise, writing every live answer back to the cache.
 *
 * A stale cached profile is preferred over nothing: it was true the last time
 * the shop could be reached. Fields are null only when they have never been read
 * successfully for this shop — callers pair the name with `storeName()`, which
 * falls back to the subdomain, and simply omit the link when the URL is null.
 *
 * Written with `updateMany` rather than an upsert on purpose: the row is created
 * and owned by the currency cache, which cannot store a placeholder currency, so
 * a shop whose currency has never been read has no row to hang a profile on yet.
 * The next admin page load creates it and the profile lands on the following
 * read.
 */
export async function shopProfile(
  shop: string,
  { admin }: { admin?: AdminApiContext } = {},
): Promise<ShopProfile> {
  let cached: {
    name: string | null;
    primaryDomainUrl: string | null;
    profileUpdatedAt: Date | null;
  } | null = null;

  try {
    cached = await prisma.shopSetting.findUnique({
      where: { shop },
      select: { name: true, primaryDomainUrl: true, profileUpdatedAt: true },
    });
  } catch (error) {
    console.warn(
      `[quotecrate] Could not read the cached shop profile for ${shop}.`,
      error,
    );
  }

  const cachedProfile: ShopProfile = {
    name: usable(cached?.name),
    url: safeUrl(usable(cached?.primaryDomainUrl)),
  };

  // Freshness is judged on the name: it is the field that is always present on a
  // successful read, whereas a shop legitimately might not resolve a URL.
  if (
    cachedProfile.name &&
    cached?.profileUpdatedAt &&
    Date.now() - cached.profileUpdatedAt.getTime() < CACHE_MAX_AGE_MS
  ) {
    return cachedProfile;
  }

  const live = await readShopProfileLive(shop, admin);
  if (live.name || live.url) {
    await rememberShopProfile(shop, live);
    return live;
  }

  if (cachedProfile.name || cachedProfile.url) {
    console.warn(
      `[quotecrate] Serving the cached profile for ${shop}; the live lookup failed.`,
    );
    return cachedProfile;
  }

  return EMPTY;
}
