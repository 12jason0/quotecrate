/**
 * Flood protection for the public quote-request endpoint.
 *
 * The endpoint is HMAC-verified, so only a real storefront can reach it — but
 * that says nothing about how often. A script pointed at the form, or a stuck
 * "submit" button, can fill the merchant's dashboard with hundreds of rows and
 * send them a notification email for every one.
 *
 * Counting rows in the database rather than keeping a bucket in memory is
 * deliberate: the limit has to hold when the app runs as more than one process,
 * and an in-memory counter would let each instance grant its own quota. The
 * quotes themselves are the record of who asked and when, so no extra state is
 * needed to count them.
 */

import prisma from "./db.server";

/** How far back a submission is counted against the limits. */
export const RATE_WINDOW_MS = 10 * 60 * 1000;

/**
 * One buyer refining a request a few times is normal; a dozen in ten minutes is
 * not a person.
 */
export const MAX_PER_EMAIL = 5;

/**
 * Backstop for the same flood spread across many addresses — including the
 * trivial bypass of varying the capitalisation of one, which the per-address
 * count matches literally and so does not catch. Set well above what a real
 * storefront produces, because refusing a genuine buyer is the worse failure.
 */
export const MAX_PER_SHOP = 60;

export type RateLimitVerdict =
  | { allowed: true }
  | { allowed: false; reason: string };

/**
 * Fails open. A counting query that cannot run is an infrastructure problem,
 * and turning it into a refusal would lose the merchant a real enquiry over it.
 */
export async function checkQuoteRequestRate(
  shop: string,
  customerEmail: string,
): Promise<RateLimitVerdict> {
  const since = new Date(Date.now() - RATE_WINDOW_MS);

  try {
    const [fromEmail, fromShop] = await Promise.all([
      prisma.quote.count({
        where: { shop, customerEmail, createdAt: { gte: since } },
      }),
      prisma.quote.count({ where: { shop, createdAt: { gte: since } } }),
    ]);

    if (fromEmail >= MAX_PER_EMAIL) {
      console.warn(
        `[quotecrate] Rate limited ${customerEmail} at ${shop}: ${fromEmail} quote requests in the last ${
          RATE_WINDOW_MS / 60000
        } minutes.`,
      );

      return {
        allowed: false,
        reason:
          "We've already received several requests from this email address. Please give us a little time to reply before sending another.",
      };
    }

    if (fromShop >= MAX_PER_SHOP) {
      console.warn(
        `[quotecrate] Rate limited ${shop}: ${fromShop} quote requests in the last ${
          RATE_WINDOW_MS / 60000
        } minutes.`,
      );

      return {
        allowed: false,
        reason:
          "We're receiving an unusually high number of quote requests right now. Please try again in a few minutes.",
      };
    }

    return { allowed: true };
  } catch (error) {
    console.warn(
      `[quotecrate] Could not check the quote request rate for ${shop}; allowing the request.`,
      error,
    );

    return { allowed: true };
  }
}
