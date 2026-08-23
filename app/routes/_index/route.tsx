import type { LoaderFunctionArgs, MetaFunction } from "react-router";
import { redirect } from "react-router";

import styles from "./styles.module.css";

/**
 * Public marketing page.
 *
 * It carries no shop-domain form. App Store requirement 2.3.1 forbids an app
 * from walking a merchant through installing itself, so installation happens
 * only through the App Store listing; a merchant who arrives here with a `shop`
 * parameter is already inside Shopify's own flow and is handed straight to the
 * embedded app below.
 */
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);

  if (url.searchParams.get("shop")) {
    throw redirect(`/app?${url.searchParams.toString()}`);
  }

  return null;
};

export const meta: MetaFunction = () => [
  { title: "QuoteCrate — B2B & Wholesale Quotes for Shopify" },
  {
    name: "description",
    content:
      "Buyers request a quote from any product page, you set the wholesale price in one click, and they check out at that price — no email back-and-forth.",
  },
  // This page is English marketing copy; Chrome auto-translate mangles lines
  // like "They pay themselves". The <div translate="no"> below covers the
  // rendered copy, this tag opts the whole document out.
  { name: "google", content: "notranslate" },
];

const FEATURES = [
  {
    icon: "📩",
    title: "Requests come to you",
    text: "Buyers submit a quote request from any product page. Every request lands in one clear list — you're notified by email the moment it arrives.",
  },
  {
    icon: "💰",
    title: "Price in a click",
    text: "Open the request, set your wholesale price per item, and send. Priced and invoiced in your store's own currency.",
  },
  {
    icon: "⚡",
    title: "They pay themselves",
    text: "Customers accept and go straight to checkout at your quoted price. No back-and-forth, no manual draft orders.",
  },
];

export default function App() {
  return (
    <div className={styles.page} translate="no">
      <header className={styles.topbar}>
        <span className={styles.brand}>📦 QuoteCrate</span>
        <span className={styles.brandNote}>
          B2B &amp; Wholesale Quotes for Shopify
        </span>
      </header>

      <section className={styles.hero}>
        <div className={styles.heroInner}>
          <span className={styles.eyebrow}>Built for wholesale sellers</span>
          <h1 className={styles.heading}>
            Wholesale quotes, from request to paid order.
          </h1>
          <p className={styles.subhead}>
            Let buyers request a quote right from your store. You set the price,
            they check out at that price — no email back-and-forth, no manual
            order building.
          </p>
        </div>
      </section>

      <section className={styles.features}>
        <ul className={styles.featureList}>
          {FEATURES.map((feature) => (
            <li className={styles.feature} key={feature.title}>
              <span className={styles.featureIcon} aria-hidden="true">
                {feature.icon}
              </span>
              <h3 className={styles.featureTitle}>{feature.title}</h3>
              <p className={styles.featureText}>{feature.text}</p>
            </li>
          ))}
        </ul>
      </section>

      <section className={styles.band}>
        <p className={styles.bandText}>
          Made to fix what slows wholesale down. A clear list of every quote,
          visible totals at a glance, and a checkout your customer completes
          themselves — so quoting feels as fast as a normal sale.
        </p>
      </section>

      <footer className={styles.footer}>
        <div className={styles.footerInner}>
          QuoteCrate · Wholesale quotes for Shopify · $14.99/mo · 14-day free
          trial
        </div>
      </footer>
    </div>
  );
}
