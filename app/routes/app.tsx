import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Outlet, useLoaderData, useRouteError } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { AppProvider } from "@shopify/shopify-app-react-router/react";

import { shouldUseTestCharge } from "../billing-mode.server";
import {
  authenticate,
  BILLING_REQUIRED,
  STANDARD_PLAN,
} from "../shopify.server";
import { shopCurrency } from "../shop-currency.server";

/**
 * `BillingError` reports every failure as "Error while billing the store" and hides
 * the real cause (appSubscriptionCreate userErrors, or top-level GraphQL errors) in
 * its `errorData` field. Surface it so billing failures are diagnosable from the logs.
 */
function logBillingError(error: unknown) {
  const errorData = (error as { errorData?: unknown })?.errorData;
  if (errorData === undefined) return;

  /* eslint-disable no-undef, no-console */
  console.error(
    "[QuoteCrate billing] %s: %s\nerrorData: %s",
    (error as Error).name,
    (error as Error).message,
    JSON.stringify(errorData, null, 2),
  );
  /* eslint-enable no-undef, no-console */
}

/**
 * The `host` parameter Shopify appends to embedded requests: base64 of
 * `admin.shopify.com/store/{store-handle}`, unpadded.
 *
 * Computed rather than only read off the request because the link built from it
 * has to work no matter which request rendered this route. A client-side
 * navigation re-runs this loader as a `.data` fetch whose URL carries none of
 * Shopify's parameters, and a link built from that request would be missing the
 * one thing the library needs to escape the iframe.
 */
function embeddedHost(shop: string): string {
  const handle = shop.replace(/\.myshopify\.com$/i, "");

  return Buffer.from(`admin.shopify.com/store/${handle}`, "utf8")
    .toString("base64")
    .replace(/=+$/, "");
}

/**
 * Where the "Start subscription" button points.
 *
 * `embedded=1` and `host` are not decoration. `billing.request` escapes the
 * admin iframe by way of `redirectOutOfApp`, which picks its strategy from the
 * request: a document request marked `embedded=1` is redirected to
 * /auth/exit-iframe, where App Bridge moves the top window. Without those
 * parameters it takes the plain-redirect branch instead and tries to load
 * Shopify's confirmation page inside the iframe, which the admin refuses to
 * frame.
 */
function subscribeUrl(request: Request, shop: string): string {
  const incoming = new URL(request.url).searchParams;

  const params = new URLSearchParams({
    shop,
    host: incoming.get("host") || embeddedHost(shop),
    embedded: "1",
  });

  return `/app/subscribe?${params.toString()}`;
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, billing, session } = await authenticate.admin(request);

  // This only reports whether a subscription is missing; it never asks for one.
  //
  // Asking from here is what created the loop this replaced: a merchant who
  // declined on Shopify's confirmation page was returned to the app, the loader
  // ran, and it sent them straight back to the page they had just declined —
  // with no explanation and no way out. App Store requirement 1.2.2 asks an app
  // to handle a declined charge, not only an accepted one. So an unsubscribed
  // shop is shown a screen that says so, and requesting the charge moved to
  // app/routes/app.subscribe.tsx, behind a button.
  //
  // Whether the charge would be a test one is the shop's own answer, not this
  // deployment's — see billing-mode.server.ts. It is resolved only when a shop
  // turns out to be unsubscribed, so a paying shop never pays for the lookup.
  let needsSubscription = false;
  if (BILLING_REQUIRED) {
    try {
      const isTest = await shouldUseTestCharge(session.shop, admin);
      const { hasActivePayment } = await billing.check({
        plans: [STANDARD_PLAN],
        isTest,
      });

      needsSubscription = !hasActivePayment;
    } catch (error) {
      // A thrown Response is the library asking for re-authentication.
      if (error instanceof Response) throw error;
      logBillingError(error);
      throw error;
    }
  }

  // eslint-disable-next-line no-undef
  const apiKey = process.env.SHOPIFY_API_KEY || "";

  // Nothing below this line is the concern of a shop that cannot use the app
  // yet, and the currency refresh costs an Admin API call.
  if (needsSubscription) {
    return {
      apiKey,
      needsSubscription,
      subscribeUrl: subscribeUrl(request, session.shop),
    };
  }

  // Every admin page in the app renders inside this route, so this is the one
  // place an authenticated admin context is guaranteed — including on the
  // merchant's first load right after install. Refreshing the shop's currency
  // here (a no-op while the cached value is fresh) is what lets the storefront
  // quote-request endpoint, which has no such context, read the currency from
  // our own database instead of a live call that can fail.
  await shopCurrency(session.shop, { admin });

  return { apiKey, needsSubscription, subscribeUrl: "" };
};

/**
 * What an unsubscribed shop sees instead of the app.
 *
 * It is a dead end by design — no app nav, no Outlet — but a dead end that
 * explains itself and offers the way forward, which is the whole difference
 * from the redirect loop it replaces. A merchant who declined can read what the
 * plan costs and start it again whenever they like.
 */
function SubscriptionRequired({ subscribeUrl }: { subscribeUrl: string }) {
  return (
    <s-page heading="QuoteCrate">
      <s-section heading="A subscription is required">
        <s-stack direction="block" gap="base">
          <s-paragraph>
            QuoteCrate needs an active subscription before quotes can be
            received, priced and sent. If you just declined the charge, nothing
            happened to your store — you can start the subscription whenever
            you&apos;re ready.
          </s-paragraph>
          <s-paragraph>
            <s-text type="strong">Standard</s-text> — $14.99 USD per 30 days,
            with a 14-day free trial. You will not be charged during the trial,
            and you can cancel from Settings → Apps and sales channels at any
            time.
          </s-paragraph>
          {/* A link, not a form. A form submission reaches the server as
              `POST /app/subscribe.data` carrying an Authorization header, which
              `redirectOutOfApp` reads as XHR: it answers with a bare 401 and
              leaves the redirect to App Bridge, which does not act on it — the
              merchant just saw "401 Unauthorized". An anchor is a document
              request, which is the branch that redirects through
              /auth/exit-iframe and actually reaches Shopify's confirmation
              page. React Router does not intercept plain anchors, so this stays
              a document navigation. */}
          <s-button href={subscribeUrl} variant="primary">
            Start subscription
          </s-button>
        </s-stack>
      </s-section>
    </s-page>
  );
}

export default function App() {
  const { apiKey, needsSubscription, subscribeUrl } =
    useLoaderData<typeof loader>();

  return (
    <AppProvider embedded apiKey={apiKey}>
      {needsSubscription ? (
        <SubscriptionRequired subscribeUrl={subscribeUrl} />
      ) : (
        <>
          <s-app-nav>
            <s-link href="/app">Home</s-link>
            <s-link href="/app/quotes">Quotes</s-link>
          </s-app-nav>
          <Outlet />
        </>
      )}
    </AppProvider>
  );
}

// Shopify needs React Router to catch some thrown responses, so that their headers are included in the response.
export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
