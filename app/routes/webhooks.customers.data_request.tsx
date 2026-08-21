/**
 * `customers/data_request` — mandatory compliance webhook.
 *
 * A buyer asked their store owner for the data this app holds about them.
 * Shopify does not collect the answer; the app supplies it to the store owner
 * directly, within 30 days.
 * https://shopify.dev/docs/apps/build/compliance/privacy-law-compliance
 *
 * `authenticateComplianceWebhook` is what verifies the request: it rejects a
 * non-POST with 405, and validates the `X-Shopify-Hmac-Sha256` header against
 * the app's API secret, throwing 401 on a bad signature and 400 on missing
 * headers (@shopify/shopify-app-react-router → api.webhooks.validate). Nothing
 * below it runs on an unsigned request, so this route cannot be used to read a
 * shop's customer data from the outside.
 */

import type { ActionFunctionArgs } from "react-router";

import { authenticateComplianceWebhook } from "../webhook-compliance.server";
import { sendCustomerDataRequest } from "../privacy-notification.server";
import { collectCustomerData } from "../privacy.server";

type DataRequestPayload = {
  shop_domain?: string;
  customer?: { id?: number; email?: string | null };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic, payload } = await authenticateComplianceWebhook(request);

  const { customer } = payload as DataRequestPayload;
  const email = customer?.email?.trim();

  // Every quote this app stores is keyed by the address the buyer typed on the
  // storefront form — the app never sees a Shopify customer id, because a quote
  // request does not require an account. Without an address there is nothing to
  // look the request up by, so acknowledge and stop rather than retry forever.
  if (!email) {
    console.log(
      `[quotecrate] ${topic} for ${shop} carried no customer email; nothing to export.`,
    );
    return new Response();
  }

  const quotes = await collectCustomerData(shop, email);

  // Logged as well as emailed: mail can be unconfigured or bounce, and the
  // merchant still has 30 days to answer their customer from this.
  console.log(
    `[quotecrate] ${topic} for ${shop}: ${quotes.length} quote(s) held for the requesting customer.`,
    JSON.stringify(quotes),
  );

  await sendCustomerDataRequest(shop, email, quotes);

  return new Response();
};
