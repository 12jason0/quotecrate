/**
 * Starting a subscription — the one place that asks Shopify for a charge.
 *
 * This exists so that requesting a charge is something the merchant does, not
 * something a page load does to them. app.tsx used to call `billing.request`
 * straight from its own loader, which meant a merchant who declined on
 * Shopify's confirmation page was sent back to that same page the instant they
 * returned: a loop with no explanation and no way out. App Store requirement
 * 1.2.2 asks an app to handle a declined charge, not just an accepted one.
 *
 * It is reached by a **link**, and the work happens in the loader, because that
 * is the only shape of request that gets out of the admin iframe.
 * `billing.request` delegates the escape to `redirectOutOfApp`, which chooses a
 * strategy by inspecting the request:
 *
 *   - A request carrying an `Authorization` header — which is every `.data`
 *     fetch React Router makes for a `<Form>` submission or a client-side
 *     navigation — is treated as XHR. It gets a bare 401 whose headers name the
 *     URL to reauthorize against, and the actual redirect is left to App Bridge.
 *     App Bridge does not act on it here, so the merchant is shown a raw
 *     "401 Unauthorized". That is what the first version of this route did.
 *   - A document request marked `embedded=1` is redirected to
 *     /auth/exit-iframe (served by auth.$.tsx), which renders the App Bridge
 *     page that moves the top window to Shopify's confirmation page. This is
 *     the branch that works, and the one the original in-loader gate used.
 *
 * So the button in app.tsx is an anchor rather than a form, and it carries the
 * `embedded=1` and `host` parameters that branch depends on.
 */

import type { LoaderFunctionArgs } from "react-router";

import { shouldUseTestCharge } from "../billing-mode.server";
import { authenticate, STANDARD_PLAN } from "../shopify.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, billing, session } = await authenticate.admin(request);

  const isTest = await shouldUseTestCharge(session.shop, admin);

  await billing.request({ plan: STANDARD_PLAN, isTest });

  // `billing.request` returns `never` — it always throws the redirect. This is
  // unreachable, and satisfies the route's return type.
  return null;
};
