import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { Form, useLoaderData, useRouteLoaderData } from "react-router";
import { useRef } from "react";

import { authenticate } from "../shopify.server";
import type { loader as appLoader, ShopPlan } from "./app";

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

function UpgradeButton({
  upgrade,
}: {
  upgrade: { shop: string; host: string };
}) {
  const formRef = useRef<HTMLFormElement>(null);

  return (
    // This has to leave as a real document request. Anything the client
    // router handles — a `<Form>` submission, a client-side navigation, and, as
    // the logs showed, an `<s-button href>` too — goes out as a single-fetch
    // `/app/subscribe.data` call carrying an Authorization header.
    // `redirectOutOfApp` reads that header as XHR: it answers with a bare 401
    // that names the confirmation URL in a header and leaves the redirect to
    // App Bridge, which does not act on it, so the merchant is shown
    // "401 Unauthorized".
    //
    // `reloadDocument` is what opts out: React Router leaves the form alone and
    // the browser navigates natively, so the request arrives as
    // `GET /app/subscribe` with no `.data` and no Authorization header — the
    // branch that redirects through /auth/exit-iframe and reaches Shopify's
    // confirmation page.
    //
    // A GET form drops the action's own query string, so the three parameters
    // that branch depends on are fields.
    <Form ref={formRef} reloadDocument method="get" action="/app/subscribe">
      <input type="hidden" name="shop" value={upgrade.shop} />
      <input type="hidden" name="host" value={upgrade.host} />
      <input type="hidden" name="embedded" value="1" />
      {/* Deliberately not `type="submit"`. Whether this custom element
          triggers a native submit is not something to leave to chance, so the
          click drives the submission explicitly and is the only thing that
          does — two paths could otherwise fire it twice. */}
      <s-button
        variant="primary"
        onClick={() => formRef.current?.requestSubmit()}
      >
        Upgrade to Standard
      </s-button>
    </Form>
  );
}

function SwitchToFreeButton() {
  const formRef = useRef<HTMLFormElement>(null);

  // An ordinary POST: cancelling is a single Admin API call and never leaves
  // the iframe, so the client router can carry it.
  return (
    <Form ref={formRef} method="post" action="/app/subscribe">
      <s-button onClick={() => formRef.current?.requestSubmit()}>
        Switch to Free
      </s-button>
    </Form>
  );
}

function PlanSection({ plan }: { plan: ShopPlan }) {
  if (plan.name === "Standard") {
    return (
      <s-section slot="aside" heading="Plan">
        <s-stack direction="block" gap="base">
          <s-paragraph>
            <s-text type="strong">Standard</s-text> — unlimited quote requests,
            $14.99 USD per 30 days.
          </s-paragraph>
          <s-paragraph>
            Switching to Free cancels the subscription. Your quotes stay as they
            are, and new requests are limited to 10 per month.
          </s-paragraph>
          <SwitchToFreeButton />
        </s-stack>
      </s-section>
    );
  }

  return (
    <s-section slot="aside" heading="Plan">
      <s-stack direction="block" gap="base">
        <s-paragraph>
          <s-text type="strong">Free plan</s-text> — {plan.used} of {plan.limit}{" "}
          quote requests used in {plan.month}.
        </s-paragraph>
        {plan.used >= plan.limit && (
          <s-paragraph>
            New quote requests are paused until next month. Quotes you already
            have can still be priced, sent and paid.
          </s-paragraph>
        )}
        <s-paragraph>
          <s-text type="strong">Standard</s-text> — unlimited quote requests,
          $14.99 USD per 30 days, with a 14-day free trial.
        </s-paragraph>
        <UpgradeButton upgrade={plan.upgrade} />
      </s-stack>
    </s-section>
  );
}

export default function Index() {
  const { setupUrl } = useLoaderData<typeof loader>();
  const plan = useRouteLoaderData<typeof appLoader>("routes/app")?.plan;

  return (
    <s-page heading="QuoteCrate">
      <s-button slot="primary-action" href="/app/quotes">
        View quotes
      </s-button>

      <s-section heading="Wholesale quotes, from request to paid order">
        <s-paragraph>
          QuoteCrate turns bulk enquiries into real Shopify orders. Buyers
          request a quote from your storefront, you set and send custom
          pricing, and the customer can accept the quote and continue directly
          to Shopify Checkout.
        </s-paragraph>
      </s-section>

      <s-section heading="How it works">
        <s-ordered-list>
          <s-list-item>
            <s-text>Request</s-text> — a buyer submits a quote request from a
            product page. The quote appears in Quotes marked{" "}
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
            line, and send it. The customer receives an email with a link to
            review the quote.
          </s-list-item>
          <s-list-item>
            <s-text>Accept &amp; checkout</s-text> — the customer reviews and
            accepts the quote, then continues to Shopify Checkout. A draft order
            is created automatically using the quoted prices.
          </s-list-item>
        </s-ordered-list>
      </s-section>

      {plan && <PlanSection plan={plan} />}

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
