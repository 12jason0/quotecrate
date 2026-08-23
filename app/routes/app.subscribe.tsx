/**
 * Starting a subscription — the one place that asks Shopify for a charge.
 *
 * This exists so that requesting a charge is something the merchant does, not
 * something a page load does to them. app.tsx used to call `billing.request`
 * straight from its loader, which meant a merchant who declined on Shopify's
 * confirmation page was sent back to that same page the instant they returned:
 * a loop with no explanation and no way out. App Store requirement 1.2.2 asks
 * an app to handle a declined charge, not just an accepted one.
 *
 * Now the loader only reports that a subscription is missing, and this action —
 * reached from a button on the screen it renders — is what asks for one.
 *
 * `billing.request` never returns: it throws the redirect to Shopify's
 * confirmation page. On this route the request arrives as a form submission
 * carrying a session token, so the library answers it with a 401 and App Bridge
 * headers, and App Bridge moves the top window. The ErrorBoundary in app.tsx is
 * what lets those headers reach the browser.
 */

import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { redirect } from "react-router";

import { shouldUseTestCharge } from "../billing-mode.server";
import { authenticate, STANDARD_PLAN } from "../shopify.server";

/** Nothing to show here; a merchant who lands on it belongs back in the app. */
export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);

  return redirect("/app");
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, billing, session } = await authenticate.admin(request);

  const isTest = await shouldUseTestCharge(session.shop, admin);

  await billing.request({ plan: STANDARD_PLAN, isTest });

  // `billing.request` returns `never`; this satisfies the route's type.
  return null;
};
