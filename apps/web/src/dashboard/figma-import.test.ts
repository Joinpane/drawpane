import { describe, expect, it } from "vitest";
import { figmaFileKey } from "./figma-import";

describe("Figma links", () => {
  it("finds the file key in any kind of link, or takes a bare key", () => {
    expect(
      figmaFileKey("https://www.figma.com/design/rvjaU14YWKozfSHkYXKCp2/Untitled?node-id=0-1"),
    ).toBe("rvjaU14YWKozfSHkYXKCp2");
    expect(figmaFileKey("figma.com/file/AbCdEfGhIjKl/Old")).toBe("AbCdEfGhIjKl");
    expect(figmaFileKey("https://www.figma.com/proto/AbCdEfGhIjKl/Flow")).toBe("AbCdEfGhIjKl");
    expect(figmaFileKey("  AbCdEfGhIjKl  ")).toBe("AbCdEfGhIjKl");
    // A branch is read by its own key.
    expect(
      figmaFileKey("https://www.figma.com/design/AbCdEfGhIjKl/branch/ZyXwVuTsRqPo/Kit?node-id=1-2"),
    ).toBe("ZyXwVuTsRqPo");
  });

  it("turns away what isn't one", () => {
    expect(figmaFileKey("https://example.com/design/AbCdEfGhIjKl")).toBeNull();
    expect(figmaFileKey("hello")).toBeNull();
    expect(figmaFileKey("")).toBeNull();
  });
});
