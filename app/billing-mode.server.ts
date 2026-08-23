/**
 * Deciding whether a shop's subscription is a test charge or a real one.
 *
 * This has to be a per-shop question, not a per-deployment one. The same
 * production build serves two kinds of store and owes them opposite answers:
 *
 *   - A dev store cannot process real transactions at all. The Billing API docs
 *     are explicit that a manual-pricing app is tested there with a test charge
 *     (https://shopify.dev/docs/apps/build/dev-dashboard/stores/development-stores).
 *     A real charge aimed at one cannot succeed, and because the billing gate
 *     runs in the embedded app's root loader, a charge that cannot succeed is
 *     not a billing bug — it is every admin page failing to load.
 *   - A merchant's own store must be charged for real, or the app is free.
 *
 * Keying this off NODE_ENV, as this module's predecessor did, answers only for
 * the deployment: on Railway NODE_ENV is "production", so every charge would be
 * a real one and the dev store — the only place this app can be verified, and
 * the kind of store an App Store reviewer installs onto — could never subscribe.
 * An environment variable would work but has to be remembered twice: set for the
 * test, unset before real merchants arrive. Forgetting the second half ships an
 * app that never charges anyone.
 *
 * So the shop is asked directly. `ShopPlan.partnerDevelopment` is the signal the
 * billing docs name for exactly this
 * (https://shopify.dev/docs/apps/launch/billing/manual-pricing/subscription-billing/offer-free-trials),
 * and it needs no configuration on either side.
 */

import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";

const SHOP_PLAN_QUERY = `#graphql
  query quoteCrateShopPlan {
    shop {
      plan {
        partnerDevelopment
      }
    }
  }`;

type ShopPlanResponse = {
  data?: {
    shop?: { plan?: { partnerDevelopment?: boolean | null } | null } | null;
  } | null;
};

/**
 * A shop does not stop being a dev store between page loads, and this is only
 * consulted when a shop has no subscription yet, so an hour is generous and
 * still short enough that a store upgraded to a paid plan is billed properly
 * the same session rather than the same day.
 */
const CACHE_MAX_AGE_MS = 60 * 60 * 1000;

/**
 * Process-local rather than a database column: this is a single boolean that is
 * cheap to re-read, and adding it to ShopSetting would mean a migration on the
 * deploy that turns billing on — the one deploy that should carry no other risk.
 */
const cache = new Map<string, { isDevelopment: boolean; readAt: number }>();

/** One quick retry, for the case where the first call lost a race with a blip. */
const RETRY_DELAY_MS = 300;

const sleep = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

async function readIsDevelopmentStore(
  shop: string,
  admin: AdminApiContext,
): Promise<boolean | null> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const response = await admin.graphql(SHOP_PLAN_QUERY);
      const json = (await response.json()) as ShopPlanResponse;
      const value = json?.data?.shop?.plan?.partnerDevelopment;
      if (typeof value === "boolean") return value;
    } catch (error) {
      // A thrown Response is the library asking for re-authentication; it is
      // the caller's to act on and must never become a boolean here.
      if (error instanceof Response) throw error;

      // eslint-disable-next-line no-undef, no-console
      console.warn(
        `[quotecrate] Shop plan lookup for ${shop} failed (attempt ${attempt + 1}).`,
        error,
      );
    }

    if (attempt === 0) await sleep(RETRY_DELAY_MS);
  }

  return null;
}

/**
 * Whether this shop's subscription should be created as a test charge.
 *
 * Outside production the answer is always yes, so local work never needs a live
 * lookup. In production it is the shop's own plan that decides.
 *
 * When the lookup cannot be answered at all the answer is yes, deliberately. The
 * two ways to be wrong are not symmetrical: a test charge on a real store means
 * the merchant is not billed for a cycle, which is visible in the admin, logged
 * loudly here, and recoverable. A real charge on a dev store means the charge
 * cannot complete and the merchant is locked out of every page of the app. Given
 * a lookup that has already failed twice, the recoverable mistake is the one to
 * make.
 */
export async function shouldUseTestCharge(
  shop: string,
  admin: AdminApiContext,
): Promise<boolean> {
  // eslint-disable-next-line no-undef
  if (process.env.NODE_ENV !== "production") return true;

  const cached = cache.get(shop);
  if (cached && Date.now() - cached.readAt < CACHE_MAX_AGE_MS) {
    return cached.isDevelopment;
  }

  const isDevelopment = await readIsDevelopmentStore(shop, admin);

  if (isDevelopment === null) {
    // eslint-disable-next-line no-undef, no-console
    console.error(
      `[quotecrate] Could not read whether ${shop} is a development store; ` +
        `falling back to a test charge, so this shop is not being billed. ` +
        `Check this shop's subscription once the Admin API is reachable again.`,
    );
    return true;
  }

  cache.set(shop, { isDevelopment, readAt: Date.now() });
  return isDevelopment;
}
