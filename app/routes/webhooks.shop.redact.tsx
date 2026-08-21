/**
 * `shop/redact` — mandatory compliance webhook.
 *
 * Sent 48 hours after a store owner uninstalls the app: everything the app
 * holds for that shop must go.
 * https://shopify.dev/docs/apps/build/compliance/privacy-law-compliance
 *
 * By the time this lands the offline session has usually been deleted by
 * `app/uninstalled`, so no session and no admin client come back here. That is
 * expected and not an error — the shop domain comes off the verified webhook
 * headers, which is all the deletion needs.
 *
 * HMAC verification is `authenticateComplianceWebhook`, which also keeps a
 * stale, unrefreshable session row from turning this into a retrying 500; see
 * the note in app/webhook-compliance.server.ts.
 */

import type { ActionFunctionArgs } from "react-router";

import { authenticateComplianceWebhook } from "../webhook-compliance.server";
import { redactShopData } from "../privacy.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic } = await authenticateComplianceWebhook(request);

  const { quotes, sessions, settings } = await redactShopData(shop);

  console.log(
    `[quotecrate] ${topic} for ${shop}: deleted ${quotes} quote(s), ${sessions} session(s) and ${settings} shop setting row(s).`,
  );

  return new Response();
};
