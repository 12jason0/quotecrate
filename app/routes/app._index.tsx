import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";

import { authenticate } from "../shopify.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);

  return null;
};

export default function Index() {
  return (
    <s-page heading="QuoteCrate">
      <s-button slot="primary-action" href="/app/quotes">
        View quotes
      </s-button>

      <s-section heading="Wholesale quotes, from request to paid order">
        <s-paragraph>
          QuoteCrate turns bulk enquiries into real Shopify orders. Buyers
          request a quote from your storefront, you set the negotiated price,
          and Shopify emails the customer a payment link for exactly that
          amount.
        </s-paragraph>
      </s-section>

      <s-section heading="How it works">
        <s-ordered-list>
          <s-list-item>
            <s-text>Request</s-text> — a buyer submits the quote request block
            from a product page. The quote appears in Quotes marked{" "}
            {/*
              Names the badge rather than rendering one. s-badge is a
              block-level status indicator — mid-sentence it broke onto its own
              line and stranded the full stop — and it takes no style prop to
              override that. s-text is the inline equivalent, so the label now
              reads as part of the sentence.
            */}
            <s-text type="strong">New</s-text>.
          </s-list-item>
          <s-list-item>
            <s-text>Price</s-text> — open the quote, enter a unit price for each
            line, and send it. The quote moves to QUOTED.
          </s-list-item>
          <s-list-item>
            <s-text>Convert</s-text> — convert the quote to a draft order.
            Shopify emails the customer an invoice with a payment link at your
            quoted prices.
          </s-list-item>
        </s-ordered-list>
      </s-section>

      <s-section slot="aside" heading="Setup">
        <s-stack direction="block" gap="small-200">
          <s-paragraph>
            Add the <s-text>Request a Quote</s-text> block to a product page in
            your theme editor so buyers can submit requests.
          </s-paragraph>
          <s-paragraph>
            Quotes are priced and invoiced in your store&apos;s own currency.
          </s-paragraph>
        </s-stack>
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
