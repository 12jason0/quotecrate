/**
 * The Free plan's monthly quote-request allowance.
 *
 * Free is not a Billing API plan. A shop is on Free simply by having no active
 * Standard subscription, so nothing here ever asks Shopify for a charge — the
 * only billing call in the app is the merchant pressing "Upgrade"
 * (app/routes/app.subscribe.tsx).
 *
 * Usage lives in QuoteUsage, one row per shop per UTC calendar month, and is
 * claimed with a single conditional upsert so concurrent requests at the limit
 * cannot both get through. A new month is a new row, so there is no reset job.
 */

import type { Prisma } from "@prisma/client";

import prisma from "./db.server";
import { shouldUseTestCharge } from "./billing-mode.server";
import { STANDARD_PLAN, unauthenticated } from "./shopify.server";

export const FREE_QUOTE_LIMIT = 5;

/** Above any count a shop can reach; used for a claim that must not be refused. */
const NO_LIMIT = 2147483647;

type Tx = Prisma.TransactionClient;

/** UTC calendar month, "YYYY-MM". */
export function currentPeriod(now: Date = new Date()): string {
  return now.toISOString().slice(0, 7);
}

export async function getQuoteUsage(
  shop: string,
  now: Date = new Date(),
): Promise<number> {
  const row = await prisma.quoteUsage.findUnique({
    where: { shop_period: { shop, period: currentPeriod(now) } },
  });

  return row?.count ?? 0;
}

/**
 * Takes one slot for this month if the count is below `limit`, in a single
 * statement. Returns false when the shop is already at the limit.
 *
 * The `WHERE` on the conflict branch is what makes this race-safe: the row is
 * locked by the upsert, and a second request waiting on it re-evaluates the
 * condition against the count the first one wrote.
 */
export async function claimQuoteSlot(
  tx: Tx,
  shop: string,
  limit: number,
  now: Date = new Date(),
): Promise<boolean> {
  const rows = await tx.$queryRaw<{ count: number }[]>`
    INSERT INTO "QuoteUsage" ("shop", "period", "count")
    VALUES (${shop}, ${currentPeriod(now)}, 1)
    ON CONFLICT ("shop", "period")
    DO UPDATE SET "count" = "QuoteUsage"."count" + 1
    WHERE "QuoteUsage"."count" < ${limit}
    RETURNING "count"`;

  return rows.length > 0;
}

type ActiveSubscription = { name: string; test: boolean };

/** Mirrors the library's `billing.check` rule for a recurring plan. */
export function hasStandard(
  subscriptions: ActiveSubscription[],
  isTest: boolean,
): boolean {
  return subscriptions.some(
    (subscription) =>
      subscription.name === STANDARD_PLAN && (isTest || !subscription.test),
  );
}

const ACTIVE_SUBSCRIPTIONS_QUERY = `#graphql
  query quoteCrateActiveSubscriptions {
    currentAppInstallation {
      activeSubscriptions {
        name
        test
      }
    }
  }`;

type ActiveSubscriptionsResponse = {
  data?: {
    currentAppInstallation?: {
      activeSubscriptions?: ActiveSubscription[] | null;
    } | null;
  } | null;
};

/**
 * Whether the shop has Standard, asked from a request that has no admin session
 * (the storefront app proxy). Null when Shopify could not be asked, which the
 * caller treats as "allow" — losing a real buyer's enquiry is the worse mistake.
 */
export async function lookupStandardPlan(
  shop: string,
): Promise<boolean | null> {
  try {
    const { admin } = await unauthenticated.admin(shop);
    const isTest = await shouldUseTestCharge(shop, admin);
    const response = await admin.graphql(ACTIVE_SUBSCRIPTIONS_QUERY);
    const json = (await response.json()) as ActiveSubscriptionsResponse;
    const subscriptions =
      json?.data?.currentAppInstallation?.activeSubscriptions;

    if (!Array.isArray(subscriptions)) return null;
    return hasStandard(subscriptions, isTest);
  } catch (error) {
    // eslint-disable-next-line no-undef, no-console
    console.error(
      `[quotecrate] Could not read ${shop}'s subscription; allowing the quote request.`,
      error,
    );
    return null;
  }
}

/**
 * Creates a quote request if the shop's plan allows it, or returns null when a
 * Free shop has used this month's allowance.
 *
 * The slot is claimed in the same transaction as the quote is written, so a
 * write that fails hands the slot back.
 *
 * The subscription lookup happens only once the Free allowance is used up, and
 * outside the transaction so no database connection waits on Shopify. Standard
 * shops (and shops whose lookup failed) still record their usage, so a shop that
 * later moves to Free is counted accurately for the rest of that month.
 */
export async function createQuoteWithinPlan<T>(
  shop: string,
  create: (tx: Tx) => Promise<T>,
  {
    enforce,
    lookup = lookupStandardPlan,
    now = new Date(),
  }: {
    enforce: boolean;
    lookup?: (shop: string) => Promise<boolean | null>;
    now?: Date;
  },
): Promise<T | null> {
  const attempt = (limit: number) =>
    prisma.$transaction(async (tx) => {
      if (!(await claimQuoteSlot(tx, shop, limit, now))) return null;
      return { value: await create(tx) };
    });

  const withinFree = await attempt(enforce ? FREE_QUOTE_LIMIT : NO_LIMIT);
  if (withinFree) return withinFree.value;

  if ((await lookup(shop)) === false) return null;

  const unlimited = await attempt(NO_LIMIT);
  return unlimited ? unlimited.value : null;
}
