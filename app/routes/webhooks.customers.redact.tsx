/**
 * `customers/redact` — mandatory compliance webhook.
 *
 * The store owner asked, on a buyer's behalf, that the buyer's data be deleted.
 * The action has to be complete within 30 days of the request.
 * https://shopify.dev/docs/apps/build/compliance/privacy-law-compliance
 *
 * What "redact" means for a quote — the row stays, its personal fields are
 * overwritten, the message thread and the public link go — is decided in
 * app/privacy.server.ts, where it can be read against the schema.
 *
 * HMAC verification is `authenticateComplianceWebhook`; see the note in
 * webhooks.customers.data_request.tsx.
 */

import type { ActionFunctionArgs } from "react-router";

import { authenticateComplianceWebhook } from "../webhook-compliance.server";
import { redactCustomerData } from "../privacy.server";

type RedactPayload = {
  shop_domain?: string;
  customer?: { id?: number; email?: string | null };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic, payload } = await authenticateComplianceWebhook(request);

  const { customer } = payload as RedactPayload;
  const email = customer?.email?.trim();

  if (!email) {
    console.log(
      `[quotecrate] ${topic} for ${shop} carried no customer email; nothing to redact.`,
    );
    return new Response();
  }

  const { quotes, messages } = await redactCustomerData(shop, email);

  console.log(
    `[quotecrate] ${topic} for ${shop}: redacted ${quotes} quote(s) and deleted ${messages} message(s).`,
  );

  return new Response();
};
