/**
 * Text as search compares it: letters without their accents, in lower
 * case, so "école", "Ecole" and "ÉCOLE" all match "École brief". The
 * Worker stores names this way (D1's lower() and LIKE only fold ASCII), and
 * the app folds what's typed the same way, so the two always agree.
 */
export function searchFold(text: string): string {
  return text.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase();
}
