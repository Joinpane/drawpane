import { type Data, emit, GENERATED_NOTE } from "./codegen.ts";
import type { NamedToken, ThemedValue, TokensSource, TypeStyle } from "./tokens-source.ts";

/**
 * Self-hosted families (from @fontsource-variable) register under their own names. They are put
 * in front of the family named in tokens.json, which stays in the stack as a fallback for a
 * locally installed copy.
 */
const SELF_HOSTED_FAMILIES: Record<string, string> = {
  "Instrument Sans": "Instrument Sans Variable",
  "JetBrains Mono": "JetBrains Mono Variable",
};

export function fontStack(stack: string): string {
  return stack
    .split(",")
    .map((family) => family.trim())
    .flatMap((family) => {
      const hosted = SELF_HOSTED_FAMILIES[family.replace(/^"|"$/g, "")];
      return hosted ? [`"${hosted}"`, family] : [family];
    })
    .join(", ");
}

/** Normalizes a CSS value the way Biome prints it: `rgba(0,0,0,0.10)` → `rgba(0, 0, 0, 0.1)`. */
function cssValue(value: string): string {
  return value
    .replace(/\(([^()]*)\)/g, (_, args: string) => `(${args.split(/\s*,\s*/).join(", ")})`)
    .replace(/(\d\.\d*?)0+\b/g, "$1")
    .replace(/(\d)\.(?=\D|$)/g, "$1");
}

function typeShorthand(style: TypeStyle): string {
  return `${style.fontWeight} ${style.fontSize} / ${style.lineHeight} var(--font-${style.family})`;
}

function block(selectors: string[], declarations: string[]): string {
  return `${selectors.join(",\n")} {\n${declarations.map((d) => `  ${d};`).join("\n")}\n}`;
}

function themedDeclarations(tokens: NamedToken<ThemedValue>[], theme: keyof ThemedValue) {
  return tokens.map((t) => `--${t.name}: ${cssValue(t.value[theme])}`);
}

export function renderTokensCss(src: TokensSource): string {
  const themed = [...src.colors, ...src.shadows];
  const statics = [...src.space, ...src.radius, ...src.size].map((t) => `--${t.name}: ${t.value}`);
  const families = Object.entries(src.families).map(([k, v]) => `--font-${k}: ${fontStack(v)}`);
  const types = src.typeStyles.map((s) => `--type-${s.name}: ${typeShorthand(s)}`);
  const textClasses = src.typeStyles.map((s) =>
    block(
      [`.dp-text-${s.name}`],
      [
        `font: var(--type-${s.name})`,
        ...(s.letterSpacing ? [`letter-spacing: ${s.letterSpacing}`] : []),
      ],
    ),
  );
  return [
    `/* ${GENERATED_NOTE} Source: design-system/tokens.json. */`,
    block(
      [":root", '[data-theme="light"]'],
      ["color-scheme: light", ...themedDeclarations(themed, "light")],
    ),
    block(['[data-theme="dark"]'], ["color-scheme: dark", ...themedDeclarations(themed, "dark")]),
    block([":root"], [...statics, ...families, ...types]),
    ...textClasses,
  ]
    .join("\n")
    .concat("\n");
}

function record<V>(tokens: NamedToken<V>[], map: (value: V) => Data): Data {
  return Object.fromEntries(tokens.map((t) => [t.name, map(t.value)]));
}

const themedData = (v: ThemedValue): Data => ({ light: v.light, dark: v.dark });

function typeStyleData(style: TypeStyle): Data {
  const { name: _name, ...rest } = style;
  return rest;
}

function presenceCount(src: TokensSource): number {
  const slots = src.colors.filter((t) => /^presence-\d+$/.test(t.name)).length;
  if (slots === 0) throw new Error("tokens.json: no presence-n color tokens");
  return slots;
}

function constant(name: string, typeName: string, data: Data): string {
  return `export const ${name} = ${emit(data)} as const;\nexport type ${typeName} = keyof typeof ${name};`;
}

export function renderTokensTs(src: TokensSource): string {
  const slots = Array.from({ length: presenceCount(src) }, (_, i) => i + 1);
  const families = Object.entries(src.families).map(([k, v]) => [k, fontStack(v)]);
  const types = src.typeStyles.map((s) => [s.name, typeStyleData(s)]);
  const sections = [
    `// ${GENERATED_NOTE} Source: design-system/tokens.json.`,
    constant("themes", "Theme", Object.fromEntries(src.themes.map((t) => [t.id, t.name]))),
    constant("colors", "ColorToken", record(src.colors, themedData)),
    constant("shadows", "ShadowToken", record(src.shadows, themedData)),
    constant(
      "space",
      "SpaceToken",
      record(src.space, (v) => v),
    ),
    constant(
      "radii",
      "RadiusToken",
      record(src.radius, (v) => v),
    ),
    constant(
      "sizes",
      "SizeToken",
      record(src.size, (v) => v),
    ),
    constant("fontFamilies", "FontFamily", Object.fromEntries(families)),
    constant("typeStyles", "TypeStyleToken", Object.fromEntries(types)),
    HELPERS.replaceAll("$COUNT", String(slots.length))
      .replace("$SLOT_UNION", slots.join(" | "))
      .replace("$SLOT_LIST", slots.join(", ")),
  ];
  return `${sections.join("\n\n")}\n`;
}

const HELPERS = `/** Every token that is a CSS custom property: \`var(--<name>)\`. */
export type Token =
  | ColorToken
  | ShadowToken
  | SpaceToken
  | RadiusToken
  | SizeToken
  | \`font-\${FontFamily}\`
  | \`type-\${TypeStyleToken}\`;

/** A CSS \`var()\` reference to a token: \`cssVar("signal")\` is \`"var(--signal)"\`. */
export function cssVar<T extends Token>(token: T): \`var(--\${T})\` {
  return \`var(--\${token})\`;
}

/** Collaborator color slot, mapping to the presence-1 … presence-$COUNT tokens. */
export type PresenceSlot = $SLOT_UNION;

const presenceSlots = [$SLOT_LIST] as const;

/** The presence slot for collaborator \`n\` (1-based). Numbers past $COUNT wrap around. */
export function presenceSlot(n: number): PresenceSlot {
  const count = presenceSlots.length;
  const index = (((Math.trunc(n) - 1) % count) + count) % count;
  return presenceSlots[index] ?? 1;
}

/** The color of collaborator \`n\` (1-based, wrapping): \`presenceColor(2)\` is \`var(--presence-2)\`. */
export function presenceColor(n: number): \`var(--presence-\${PresenceSlot})\` {
  return \`var(--presence-\${presenceSlot(n)})\`;
}`;
