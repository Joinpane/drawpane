// Reads and validates design-system/tokens.json, the single source for every Drawpane token.

export interface ThemedValue {
  light: string;
  dark: string;
}

export interface NamedToken<V> {
  name: string;
  value: V;
}

export interface TypeStyle {
  name: string;
  family: string;
  fontSize: string;
  lineHeight: string;
  fontWeight: number;
  letterSpacing?: string;
}

export interface TokensSource {
  themes: { id: string; name: string }[];
  colors: NamedToken<ThemedValue>[];
  shadows: NamedToken<ThemedValue>[];
  space: NamedToken<string>[];
  radius: NamedToken<string>[];
  size: NamedToken<string>[];
  families: Record<string, string>;
  typeStyles: TypeStyle[];
}

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fail(path: string, expected: string): never {
  throw new Error(`tokens.json: expected ${expected} at ${path}`);
}

function obj(value: unknown, path: string): Json {
  return isObject(value) ? value : fail(path, "an object");
}

function arr(value: unknown, path: string): unknown[] {
  return Array.isArray(value) ? value : fail(path, "an array");
}

function str(value: unknown, path: string): string {
  return typeof value === "string" ? value : fail(path, "a string");
}

function num(value: unknown, path: string): number {
  return typeof value === "number" ? value : fail(path, "a number");
}

function themed(value: unknown, path: string): ThemedValue {
  const v = obj(value, path);
  return { light: str(v.light, `${path}.light`), dark: str(v.dark, `${path}.dark`) };
}

function tokenList<V>(
  group: unknown,
  path: string,
  read: (value: unknown, path: string) => V,
): NamedToken<V>[] {
  return arr(obj(group, path).tokens, `${path}.tokens`).map((entry, i) => {
    const t = obj(entry, `${path}.tokens[${i}]`);
    return {
      name: str(t.name, `${path}.tokens[${i}].name`),
      value: read(t.value, `${path}[${i}]`),
    };
  });
}

export function parseTokens(json: unknown): TokensSource {
  const root = obj(json, "$");
  const color = obj(root.color, "color");
  const type = obj(root.type, "type");
  const families = obj(type.families, "type.families");

  const typeStyles = arr(type.groups, "type.groups").flatMap((g, gi) => {
    const group = obj(g, `type.groups[${gi}]`);
    const family = str(group.family, `type.groups[${gi}].family`);
    return arr(group.styles, `type.groups[${gi}].styles`).map((s, si): TypeStyle => {
      const p = `type.groups[${gi}].styles[${si}]`;
      const style = obj(s, p);
      const base: TypeStyle = {
        name: str(style.name, `${p}.name`),
        family,
        fontSize: str(style.fontSize, `${p}.fontSize`),
        lineHeight: str(style.lineHeight, `${p}.lineHeight`),
        fontWeight: num(style.fontWeight, `${p}.fontWeight`),
      };
      return style.letterSpacing === undefined
        ? base
        : { ...base, letterSpacing: str(style.letterSpacing, `${p}.letterSpacing`) };
    });
  });

  return {
    themes: arr(color.themes, "color.themes").map((t, i) => {
      const theme = obj(t, `color.themes[${i}]`);
      return { id: str(theme.id, `color.themes[${i}].id`), name: str(theme.name, "name") };
    }),
    colors: tokenList(color, "color", themed),
    shadows: tokenList(root.shadow, "shadow", themed),
    space: tokenList(root.spacing, "spacing", str),
    radius: tokenList(root.radius, "radius", str),
    size: tokenList(root.size, "size", str),
    families: Object.fromEntries(
      Object.entries(families).map(([k, v]) => [k, str(v, `type.families.${k}`)]),
    ),
    typeStyles,
  };
}
