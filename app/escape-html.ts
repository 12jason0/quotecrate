/**
 * HTML escaping for the templates this app builds by hand.
 *
 * Both outbound emails are assembled as HTML strings, and every value that goes
 * into them is storefront input — a shopper's name, company or note. So the
 * escaping has to be one implementation used by both, rather than a copy per
 * file that can drift.
 */

const HTML_ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => HTML_ESCAPES[character]);
}

/** Free-text notes are typed with line breaks; keep them visible. */
export function escapeMultiline(value: string): string {
  return escapeHtml(value).replace(/\r?\n/g, "<br />");
}
