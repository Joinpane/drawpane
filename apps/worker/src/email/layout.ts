/**
 * How Drawpane's emails look: one card on a warm page, a heading, rows, and
 * a small footer saying why it came. Inline styles and tables only, because
 * that is what mail apps render; the plain-text twin always carries the same
 * content.
 */

const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
const INK = "#1c1b19";
const MUTED = "#57534e";
const FAINT = "#78716c";
const LINE = "#e6e3de";
const SIGNAL = "#c2410c";

/** Text made safe for HTML, in content and in double-quoted attributes. */
export const escapeHtml = (text: string) =>
  text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

/** Text on one line, cut with an ellipsis past `max` characters. */
export const oneLine = (text: string, max = 200) => {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat;
};

/** A row of the card. `divider`: a hairline above it, between items. */
export function emailRow(html: string, { divider = false } = {}): string {
  const border = divider ? `border-top:1px solid ${LINE};` : "";
  return `<tr><td style="padding:14px 0;${border}">${html}</td></tr>`;
}

const TEXT = {
  /** The email's one main sentence. */
  lead: `font:400 15px/22px ${FONT};color:${INK}`,
  /** An item's headline: "Bo mentioned you in Onboarding". */
  title: `font:600 14px/20px ${FONT};color:${INK}`,
  /** What it says, under the title. */
  body: `font:400 14px/20px ${FONT};color:${MUTED}`,
  /** A small aside: "Joins as editor · expires in 7 days". */
  note: `font:400 13px/18px ${FONT};color:${MUTED}`,
  /** A web address shown as text: it breaks anywhere, so a long one can't widen the email. */
  url: `font:400 13px/18px ${FONT};color:${MUTED};word-break:break-all`,
} as const;

/** A paragraph in a row; `gap` puts space above it, under what came before. */
export function emailText(text: string, tone: keyof typeof TEXT, { gap = 0 } = {}): string {
  const margin = gap ? `margin-top:${gap}px;` : "";
  return `<div style="${margin}${TEXT[tone]}">${escapeHtml(text)}</div>`;
}

/** A quiet link, like "Open the comment →". */
export function emailLink(href: string, label: string): string {
  return `<a href="${escapeHtml(href)}" style="font:500 13px/18px ${FONT};color:${SIGNAL};text-decoration:none">${escapeHtml(label)}</a>`;
}

/** The one thing to do: a filled button that works in every mail app (a table cell, not CSS). */
export function emailButton(href: string, label: string): string {
  return `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:4px 0"><tr>
    <td style="border-radius:8px;background:${SIGNAL}">
      <a href="${escapeHtml(href)}" style="display:inline-block;padding:11px 20px;font:600 14px/20px ${FONT};color:#ffffff;text-decoration:none;border-radius:8px">${escapeHtml(label)}</a>
    </td></tr></table>`;
}

/**
 * The whole HTML document. `preheader`: the line mail apps show next to the
 * subject. `footer` is HTML (it holds links): build it with escapeHtml.
 */
export function emailPage({
  heading,
  preheader,
  rows,
  footer,
}: {
  heading: string;
  preheader?: string | undefined;
  rows: readonly string[];
  footer: string;
}): string {
  const hidden = preheader
    ? `<div style="display:none;max-height:0;overflow:hidden;opacity:0">${escapeHtml(preheader)}</div>`
    : "";
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"></head>
<body style="margin:0;padding:24px 12px;background:#f6f4f0">${hidden}
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;margin:0 auto;background:#ffffff;border-radius:12px">
    <tr><td style="padding:8px 24px 20px">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
        <tr><td style="padding:16px 0 8px;font:600 16px/22px ${FONT};color:${INK}">${escapeHtml(heading)}</td></tr>
        ${rows.join("\n        ")}
      </table>
    </td></tr>
  </table>
  <p style="max-width:560px;margin:16px auto 0;font:400 12px/18px ${FONT};color:${FAINT}">${footer}</p>
</body></html>`;
}

/** A footer link, in the footer's own quiet color. */
export function footerLink(href: string, label: string): string {
  return `<a href="${escapeHtml(href)}" style="color:${FAINT}">${escapeHtml(label)}</a>`;
}
