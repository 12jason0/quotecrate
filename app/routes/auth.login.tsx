/**
 * `/auth/login` — kept only so the path resolves, and deliberately carries no UI.
 *
 * The template shipped a form here that asked the merchant to type their shop
 * domain. App Store requirement 2.3.1 forbids exactly that: an app "must not
 * request the manual entry of a myshopify.com URL or a shop's domain during the
 * installation or configuration flow". The form was also unnecessary — this app
 * uses Shopify managed installation (`use_legacy_install_flow = false`), so a
 * shop is identified by the session token or the OAuth flow, never by typing.
 *
 * The route is replaced rather than deleted. `auth.$.tsx` is a splat over
 * `/auth/*` and calls `authenticate.admin`, which special-cases the configured
 * login path: reaching it without a shop parameter throws a 500 carrying a
 * developer-facing message (see the library's validate-shop-and-host-params).
 * Deleting the directory would hand `/auth/login` to that splat and turn a dead
 * link into a server error. Redirecting keeps it a dead end that lands
 * somewhere sensible.
 *
 * Query parameters are carried over so a request that does arrive with `shop`
 * is picked up by the index route, which forwards it into the embedded app.
 */

import type { LoaderFunctionArgs } from "react-router";
import { redirect } from "react-router";

export const loader = ({ request }: LoaderFunctionArgs) => {
  const query = new URL(request.url).searchParams.toString();

  return redirect(query ? `/?${query}` : "/");
};
