import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { useLoaderData } from "react-router";

import { authenticate } from "../shopify.server";

/**
 * The filename of the block's Liquid file, without the extension —
 * extensions/quote-request/blocks/request_quote.liquid.
 */
const BLOCK_HANDLE = "request_quote";

/**
 * A theme editor deep link that adds the quote block to the main section of the
 * shop's live product template, so the merchant lands on a preview of it rather
 * than having to find it in a block picker. App Store requirement 5.1.3 asks
 * for setup instructions and recommends exactly this.
 *
 * The identifier is the app's api_key — the same value as `client_id`. The
 * theme app extension's own `uuid` used to go here and is now deprecated in
 * favour of it, which is convenient: the api_key is already in this app's
 * environment, while the extension uuid would have to be threaded in from the
 * deploy.
 * https://shopify.dev/docs/apps/build/online-store/theme-app-extensions/configuration
 */
function themeEditorDeepLink(shop: string, apiKey: string): string {
  const params = new URLSearchParams({
    template: "product",
    addAppBlockId: `${apiKey}/${BLOCK_HANDLE}`,
    target: "mainSection",
  });

  return `https://${shop}/admin/themes/current/editor?${params.toString()}`;
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);

  // eslint-disable-next-line no-undef
  const apiKey = process.env.SHOPIFY_API_KEY || "";

  return { setupUrl: themeEditorDeepLink(session.shop, apiKey) };
};

export default function Index() {
  const { setupUrl } = useLoaderData<typeof loader>();

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
        <s-stack direction="block" gap="base">
          <s-paragraph>
            Buyers can only request quotes once the{" "}
            <s-text type="strong">Request a Quote</s-text> block is on your
            storefront. The button below opens your theme editor with the block
            already added to your product page, ready to preview.
          </s-paragraph>

          {/* Opens the merchant's own admin, so it has to break out of this
              iframe rather than navigate inside it. */}
          <s-button href={setupUrl} target="_blank" variant="primary">
            Add the block to my theme
          </s-button>

          <s-ordered-list>
            <s-list-item>
              Select <s-text type="strong">Add the block to my theme</s-text>.
              The theme editor opens on your product template with the block in
              place.
            </s-list-item>
            <s-list-item>
              Drag the block where you want it to appear on the page — most
              stores put it under the Add to cart button.
            </s-list-item>
            <s-list-item>
              Optional: set a{" "}
              <s-text type="strong">Wholesale collection</s-text> in the
              block&apos;s settings so buyers can request several products at
              once. Leave it empty to quote only the product being viewed.
            </s-list-item>
            <s-list-item>
              Select <s-text type="strong">Save</s-text>. Requests then arrive
              under Quotes, and you are emailed as each one comes in.
            </s-list-item>
          </s-ordered-list>

          <s-paragraph>
            Using a theme that does not support app blocks? Open{" "}
            <s-text type="strong">Online Store → Themes → Customize</s-text>,
            then add <s-text type="strong">Request a Quote</s-text> from the
            Apps section of any product section.
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
