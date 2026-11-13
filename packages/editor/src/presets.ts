/**
 * Frame presets: common screens, paper and social sizes, in points (CSS
 * pixels). The frame tool lists them, and a selected frame can switch to one.
 * Apple sizes are the logical resolution its simulators and Safari report.
 */
export interface FramePreset {
  readonly id: string;
  readonly name: string;
  readonly width: number;
  readonly height: number;
}

export interface FramePresetGroup {
  readonly name: string;
  readonly presets: readonly FramePreset[];
}

const p = (id: string, name: string, width: number, height: number): FramePreset => ({
  id,
  name,
  width,
  height,
});

export const FRAME_PRESETS: readonly FramePresetGroup[] = [
  {
    name: "Phone",
    presets: [
      p("iphone-18-pro-max", "iPhone 18 Pro Max", 440, 956),
      p("iphone-18-pro", "iPhone 18 Pro", 402, 874),
      p("iphone-air", "iPhone Air", 420, 912),
      p("iphone-17", "iPhone 17", 402, 874),
      p("iphone-16e", "iPhone 16e", 390, 844),
      p("iphone-16-plus", "iPhone 16 Plus", 430, 932),
      p("iphone-16", "iPhone 16", 393, 852),
      p("iphone-se", "iPhone SE", 375, 667),
      p("pixel-9", "Google Pixel 9", 412, 923),
      p("galaxy-s25", "Samsung Galaxy S25", 360, 780),
      p("android-compact", "Android compact", 412, 917),
    ],
  },
  {
    name: "Tablet",
    presets: [
      p("ipad-pro-13", "iPad Pro 13″", 1032, 1376),
      p("ipad-pro-11", "iPad Pro 11″", 834, 1210),
      p("ipad-air-13", "iPad Air 13″", 1024, 1366),
      p("ipad-air-11", "iPad Air 11″", 820, 1180),
      p("ipad", "iPad", 820, 1180),
      p("ipad-mini", "iPad mini", 744, 1133),
      p("android-medium", "Android medium", 700, 840),
      p("android-expanded", "Android expanded", 1280, 800),
    ],
  },
  {
    name: "Desktop",
    presets: [
      p("macbook-air", "MacBook Air", 1280, 832),
      p("macbook-pro-14", "MacBook Pro 14″", 1512, 982),
      p("macbook-pro-16", "MacBook Pro 16″", 1728, 1117),
      p("desktop", "Desktop", 1440, 1024),
      p("desktop-hd", "Desktop HD", 1920, 1080),
      p("laptop", "Laptop", 1366, 768),
      p("small-desktop", "Small desktop", 1280, 800),
    ],
  },
  {
    name: "Watch",
    presets: [
      p("apple-watch-ultra", "Apple Watch Ultra", 205, 251),
      p("apple-watch-46", "Apple Watch 46mm", 208, 248),
      p("apple-watch-42", "Apple Watch 42mm", 187, 223),
    ],
  },
  {
    name: "Paper",
    presets: [
      p("a4", "A4", 595, 842),
      p("a5", "A5", 420, 595),
      p("letter", "Letter", 612, 792),
      p("tabloid", "Tabloid", 792, 1224),
    ],
  },
  {
    name: "Social",
    presets: [
      p("instagram-post", "Instagram post", 1080, 1080),
      p("instagram-portrait", "Instagram portrait", 1080, 1350),
      p("instagram-story", "Instagram story", 1080, 1920),
      p("x-post", "X post", 1600, 900),
      p("linkedin-post", "LinkedIn post", 1200, 627),
      p("facebook-cover", "Facebook cover", 820, 312),
      p("youtube-thumbnail", "YouTube thumbnail", 1280, 720),
    ],
  },
  {
    name: "Presentation",
    presets: [p("slide-16-9", "Slide 16:9", 1920, 1080), p("slide-4-3", "Slide 4:3", 1024, 768)],
  },
];

const BY_ID = new Map(FRAME_PRESETS.flatMap((g) => g.presets.map((x) => [x.id, x] as const)));

export function framePreset(id: string): FramePreset | undefined {
  return BY_ID.get(id);
}

/**
 * The preset a size matches, in either orientation, so a selected frame
 * shows "iPhone 18 Pro" when it's 402×874 or 874×402. The first match wins.
 */
export function matchFramePreset(width: number, height: number): FramePreset | undefined {
  for (const group of FRAME_PRESETS) {
    for (const preset of group.presets) {
      if (
        (preset.width === width && preset.height === height) ||
        (preset.width === height && preset.height === width)
      )
        return preset;
    }
  }
  return undefined;
}
