declare module "bidi-js" {
  interface EmbeddingLevels {
    readonly levels: Uint8Array;
    readonly paragraphs: ReadonlyArray<{
      readonly start: number;
      readonly end: number;
      readonly level: number;
    }>;
  }

  export default function createBidi(): {
    getEmbeddingLevels(text: string, direction?: "ltr" | "rtl"): EmbeddingLevels;
  };
}
