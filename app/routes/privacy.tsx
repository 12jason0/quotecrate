/**
 * Public privacy policy, linked from the App Store listing.
 *
 * Deliberately a top-level route rather than a child of `app.tsx`: reviewers,
 * buyers and merchants reach this URL directly in a browser with no Shopify
 * session, so it must never touch `authenticate.admin` or App Bridge. It is a
 * resource route — the loader returns the finished HTML document itself, so no
 * React runtime or client bundle is involved in serving it.
 *
 * The document is static text, so it is built as one string constant rather
 * than assembled from data. Nothing here is user input, and nothing here needs
 * escaping.
 */

const STYLES = `
  :root {
    --qc-page-bg: #fffdf9;
    --qc-surface: #ffffff;
    --qc-header-bg: #3b2416;
    --qc-header-text: #ffffff;
    --qc-accent: #a4552b;
    --qc-accent-strong: #8b4522;
    --qc-text: #3b2416;
    --qc-muted: #786651;
    --qc-muted-strong: #665541;
    --qc-total-bg: #f6efe3;
    --qc-rule: #ecdfcb;

    --qc-card-radius: 22px;
    --qc-max-width: 720px;

    --qc-font: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto,
      "Helvetica Neue", Arial, sans-serif;
    --qc-heading-font: "Iowan Old Style", "Palatino Linotype", Palatino,
      Georgia, serif;
  }

  *, *::before, *::after { box-sizing: border-box; }

  body {
    margin: 0;
    padding: 28px 16px 64px;
    background: var(--qc-page-bg);
    color: var(--qc-text);
    font: 16px/1.6 var(--qc-font);
    -webkit-font-smoothing: antialiased;
  }

  .wrap { max-width: var(--qc-max-width); margin: 0 auto; }

  .card {
    background: var(--qc-surface);
    border-radius: var(--qc-card-radius);
    box-shadow: 0 1px 2px rgba(59, 36, 22, .06), 0 8px 28px rgba(59, 36, 22, .07);
    overflow: hidden;
  }

  .hero {
    background: var(--qc-header-bg);
    color: var(--qc-header-text);
    padding: 34px 34px 32px;
  }
  .hero h1 {
    font-family: var(--qc-heading-font);
    font-size: 32px;
    line-height: 1.15;
    font-weight: 600;
    margin: 0 0 10px;
  }
  .hero__date {
    margin: 0;
    font-size: 14px;
    color: rgba(255, 255, 255, .72);
  }

  .body { padding: 30px 34px 36px; }

  h2 {
    font-family: var(--qc-heading-font);
    font-size: 21px;
    font-weight: 600;
    margin: 34px 0 10px;
    padding-top: 22px;
    border-top: 1px dashed var(--qc-rule);
  }

  p { margin: 0 0 14px; }
  p:last-child { margin-bottom: 0; }

  ul { margin: 0 0 14px; padding-left: 22px; }
  li { margin-bottom: 8px; }
  li:last-child { margin-bottom: 0; }

  /* Sentence that introduces a list belongs to the list, not to the prose
     above it. */
  .lead-in { margin-bottom: 10px; }

  /* Reads as a caveat rather than as one more paragraph of policy. */
  .callout {
    background: var(--qc-total-bg);
    border-radius: 14px;
    padding: 16px 20px;
    margin: 0 0 14px;
    color: var(--qc-muted-strong);
    font-size: 15px;
  }

  a { color: var(--qc-accent); text-decoration: underline; text-underline-offset: 3px; }
  a:hover { color: var(--qc-accent-strong); }

  strong { font-weight: 600; }

  @media (max-width: 560px) {
    body { padding: 16px 12px 48px; }
    .hero { padding: 26px 20px 24px; }
    .hero h1 { font-size: 27px; }
    .body { padding: 24px 20px 28px; }
    h2 { font-size: 19px; margin-top: 28px; padding-top: 20px; }
  }
`;

const HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Privacy Policy — QuoteCrate</title>
<meta name="description" content="How the QuoteCrate Shopify app handles personal data: what it collects, why, who it is shared with, and how it is kept and deleted.">
<style>${STYLES}</style>
</head>
<body>
<div class="wrap">
  <main class="card">
    <header class="hero">
      <h1>QuoteCrate — Privacy Policy</h1>
      <p class="hero__date">Effective date: August 23, 2026</p>
    </header>
    <div class="body">
      <p>QuoteCrate is a Shopify app that lets a store's B2B and wholesale buyers request a quote, lets the merchant price it, and lets the buyer accept and check out at that price. This policy explains what personal data the app handles, why, who it is shared with, and how it is kept and deleted.</p>

      <h2>Who we are</h2>
      <p>QuoteCrate ("the app", "we") is operated by Seung Yong Oh, based in the Republic of Korea. For any privacy question or request, contact us at <a href="mailto:12jason@donacouse.com">12jason@donacouse.com</a>.</p>

      <h2>What we collect</h2>
      <p>We collect only what the quote workflow needs.</p>
      <p class="lead-in">From a store's buyers (entered on the merchant's storefront quote-request form, and in the quote conversation):</p>
      <ul>
        <li>Name</li>
        <li>Email address</li>
        <li>Company name (optional)</li>
        <li>The note and messages the buyer writes about their quote</li>
        <li>The products and quantities the buyer requests</li>
      </ul>
      <p class="lead-in">From the merchant / store (to run the app inside Shopify admin):</p>
      <ul>
        <li>Shopify session data provided by Shopify when the app is installed (store domain, access token, and — for logged-in staff — the staff member's name and email).</li>
        <li>Store-level information read from the Shopify Admin API: the store's name, currency, primary storefront domain, and the store's contact email (used only to send the merchant their quote notifications).</li>
      </ul>
      <p class="callout"><strong>What we do NOT collect:</strong> We do not read your customers' data through the Shopify Admin API — buyer details come only from the quote form. We do not use cookies, analytics, advertising, or behavioral tracking on your storefront. The app runs inside Shopify admin using Shopify's own session tokens.</p>

      <h2>How we use it</h2>
      <ul>
        <li>To deliver quote requests to the merchant and show them in one list.</li>
        <li>To let the merchant price a quote and send it, and to notify the merchant by email when a request or message arrives.</li>
        <li>To email the buyer that their quote is ready and let them accept it.</li>
        <li>To create a Shopify draft order and checkout link when a quote is accepted, so the buyer can pay the quoted price.</li>
      </ul>
      <p>We do not sell personal data, and we do not use it for advertising.</p>

      <h2>Who we share it with (sub-processors)</h2>
      <ul>
        <li><strong>Shopify</strong> — the platform the app runs on; creating the draft order / checkout when a quote is accepted. Data: buyer name and email, line items and prices.</li>
        <li><strong>Resend</strong> — sending transactional email (quote notifications, "quote ready", conversation messages). Data: recipient email address and message content.</li>
        <li><strong>Neon</strong> — database hosting where quote data is stored (United States). Data: all stored quote data.</li>
        <li><strong>Railway</strong> — application hosting (European Union). Data: data in transit while the app runs.</li>
      </ul>

      <h2>Where data is processed</h2>
      <p>The app is operated from the Republic of Korea. Quote data is stored in a database hosted in the United States (Neon), and the application is hosted in the European Union (Railway). By using the app you understand that data may be processed in these locations.</p>

      <h2>How long we keep it, and deletion</h2>
      <p>We keep quote data for as long as the app is installed on the store, because a quote is the merchant's own record of a negotiation and order. Data is deleted or redacted in line with Shopify's mandatory privacy webhooks:</p>
      <ul>
        <li><strong>Customer data request</strong> — When a store owner forwards a buyer's request for their data, we compile everything we hold about that buyer for that store and provide it to the store owner to pass on.</li>
        <li><strong>Customer redaction</strong> — When a buyer's data is to be erased, we remove their name, email, company, note and the entire message thread from that store's quotes, and disable the buyer's private quote link. The quote record itself is kept in redacted form because it is the merchant's business/order record.</li>
        <li><strong>Shop redaction</strong> — About 48 hours after a merchant uninstalls the app, we permanently delete all of that store's quote data, line items, messages, settings and sessions.</li>
      </ul>

      <h2>Your rights</h2>
      <p>Depending on where you live, you may have the right to access, correct, or delete your personal data, or to object to or restrict its processing. Buyers should contact the store they requested a quote from; the store can request the data from us or ask us to redact it. Merchants and anyone else can also contact us directly at <a href="mailto:12jason@donacouse.com">12jason@donacouse.com</a> and we will respond.</p>

      <h2>Data security</h2>
      <p>Data is transmitted over encrypted connections (HTTPS/TLS) and stored with our database provider under their security controls. Access tokens and secrets are kept in server-side configuration, never exposed to the storefront.</p>

      <h2>Children</h2>
      <p>The app is a business tool for wholesale ordering and is not directed to children.</p>

      <h2>Changes to this policy</h2>
      <p>We may update this policy as the app changes. The effective date at the top shows when it was last updated. Material changes will be reflected here.</p>

      <h2>Contact</h2>
      <p>Questions or requests about this policy or your data: <a href="mailto:12jason@donacouse.com">12jason@donacouse.com</a> (Seung Yong Oh, Republic of Korea).</p>
    </div>
  </main>
</div>
</body>
</html>`;

export function loader(): Response {
  return new Response(HTML, {
    status: 200,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      // Static document, safe in a shared cache. Kept short so a policy edit
      // goes live in minutes rather than whenever a cache decides to expire.
      "Cache-Control": "public, max-age=300",
    },
  });
}
