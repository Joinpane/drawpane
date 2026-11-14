/**
 * Every page is served with a Content Security Policy (PRD, security): only
 * this origin's scripts run, nothing frames the app, and nothing it renders
 * reaches out to other origins except the fonts it's allowed to load.
 */
import { expect, test } from "@playwright/test";

test("pages are served with a Content Security Policy", async ({ request }) => {
  for (const path of ["/", "/signin", "/t/anything", "/f/anything"]) {
    const response = await request.get(path);
    const csp = response.headers()["content-security-policy"] ?? "";
    expect(csp, path).toContain("default-src 'self'");
    expect(csp, path).toMatch(/script-src 'self'(?![^;]*'unsafe-inline')/);
    expect(csp, path).toContain("frame-ancestors 'none'");
    expect(csp, path).toContain("object-src 'none'");
  }
});
