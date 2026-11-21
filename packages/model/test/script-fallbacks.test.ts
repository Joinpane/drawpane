import { describe, expect, it } from "vitest";
import {
  cjkRegionFor,
  scriptFallbackFamily,
  scriptSlice,
  scriptSubsets,
} from "../src/script-fallbacks";

describe("engine script fallback catalogue", () => {
  it("uses kana or Hangul in the same node before looking at the viewer locale", () => {
    expect(
      scriptSubsets(["骨\nコーヒー・日本"], "zh-Hant").filter((face) => face.subset === "9a00"),
    ).toEqual([{ family: "Noto Sans JP", subset: "9a00" }]);
    expect(cjkRegionFor("骨\n한글", "ja-JP")).toBe("KR");
    expect(cjkRegionFor("骨", "zh-TW")).toBe("TC");
    expect(cjkRegionFor("哈利・波特", "zh-TW")).toBe("TC");
    expect(cjkRegionFor("骨･한글", "ja-JP")).toBe("KR");
    expect(cjkRegionFor("骨゛゜ー", "zh-CN")).toBe("SC");
    expect(cjkRegionFor("骨", "zh-Hant-HK")).toBe("TC");
    expect(cjkRegionFor("骨", "zh-CN")).toBe("SC");
    expect(cjkRegionFor("骨", "ja-JP")).toBe("JP");
    expect(cjkRegionFor("骨", "ko-KR")).toBe("KR");
  });

  it("maps kana punctuation and combining marks to the Japanese slice", () => {
    expect([..."ー・゙゛゜"].map((char) => scriptFallbackFamily(char))).toEqual(
      Array(5).fill("Noto Sans JP"),
    );
    expect(scriptSubsets(["コーヒー・"])).toEqual([{ family: "Noto Sans JP", subset: "3000" }]);
  });

  it("maps different text to the same catalogue slice and rejects arbitrary ranges", () => {
    expect(scriptSubsets(["中"], "zh-TW")).toEqual(scriptSubsets(["东"], "zh-TW"));
    expect(scriptSlice("Noto Sans TC", "4e00")).toEqual({ start: 0x4e00, end: 0x4eff });
    expect(scriptSlice("Noto Sans TC", "4e01")).toBeNull();
    expect(scriptSlice("Noto Sans TC", "1000")).toBeNull();
    expect(scriptSubsets(["سعر אב"])).toEqual([
      { family: "Noto Sans Arabic", subset: "all" },
      { family: "Noto Sans Hebrew", subset: "all" },
    ]);
  });
});
