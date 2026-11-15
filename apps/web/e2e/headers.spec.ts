/**
 * Every page is served with a Content Security Policy (PRD, security): only
 * this origin's scripts run, nothing frames the app, and nothing it renders
 * reaches out to other origins except the fonts it's allowed to load, and
 * Figma, which the Import dialog calls from the page so the token goes only
 * there.
 */
import { expect, test } from "@playwright/test";

/** Everywhere the page may connect to: itself, and Figma's API and image storage. */
const CONNECT = [
  "'self'",
  "https://api.figma.com",
  "https://s3-alpha-sig.figma.com",
  "https://figma-alpha-api.s3.us-west-2.amazonaws.com",
  "https://s3-us-west-2.amazonaws.com/figma-alpha-api/",
];

test("pages are served with a Content Security Policy", async ({ request }) => {
  for (const path of ["/", "/signin", "/t/anything", "/f/anything"]) {
    const response = await request.get(path);
    const csp = response.headers()["content-security-policy"] ?? "";
    expect(csp, path).toContain("default-src 'self'");
    expect(csp, path).toMatch(/script-src 'self'(?![^;]*'unsafe-inline')/);
    expect(csp, path).toContain("frame-ancestors 'none'");
    expect(csp, path).toContain("object-src 'none'");
    const connect = /connect-src ([^;]*)/.exec(csp)?.[1]?.trim().split(/\s+/);
    expect(connect, path).toEqual(CONNECT);
  }
});
