/**
 * Verifying a compliance webhook without letting a dead session fail it.
 *
 * `authenticate.webhook` does two things in order: it validates the request
 * (405 on a non-POST, 401 on a bad `X-Shopify-Hmac-Sha256`, 400 on missing
 * headers), and only then loads the shop's offline session so it can hand back
 * an admin client.
 *
 * That second step is a liability here. This app sets
 * `future.expiringOfflineAccessTokens`, so when a session row is still on file
 * with an expired token the helper calls Shopify to refresh it — and
 * `shop/redact` arrives 48 hours *after* the uninstall, when that refresh can
 * only fail. The throw would come back as a 500, Shopify would retry, and a
 * mandatory webhook that reports as failing is exactly what blocks a review.
 *
 * So the two outcomes are separated. A thrown `Response` is the validation
 * verdict and is passed straight through — an unsigned request must still be
 * refused. Anything else was thrown *after* the HMAC checked out, which means
 * the body is genuinely from Shopify, so the request is re-read from a clone
 * and the redaction goes ahead. None of the three handlers needs the admin
 * client; they only ever act on our own database.
 */

import { authenticate } from "./shopify.server";

export type ComplianceWebhook = {
  shop: string;
  topic: string;
  payload: unknown;
};

/** The library's own normalisation, so logs read the same on both paths. */
function topicForStorage(topic: string): string {
  return topic.toUpperCase().replace(/\/|\./g, "_");
}

export async function authenticateComplianceWebhook(
  request: Request,
): Promise<ComplianceWebhook> {
  // Taken before `authenticate.webhook` consumes the body.
  const verified = request.clone();

  try {
    const { shop, topic, payload } = await authenticate.webhook(request);
    return { shop, topic, payload };
  } catch (error) {
    // 405 / 401 / 400 — the request never proved it came from Shopify.
    if (error instanceof Response) throw error;

    const shop = verified.headers.get("X-Shopify-Shop-Domain");
    const topic = verified.headers.get("X-Shopify-Topic");

    if (!shop || !topic) throw error;

    console.warn(
      `[quotecrate] ${topicForStorage(topic)} for ${shop} passed HMAC but the offline session could not be loaded; continuing without an admin client.`,
      error,
    );

    return {
      shop,
      topic: topicForStorage(topic),
      payload: await verified.json(),
    };
  }
}
