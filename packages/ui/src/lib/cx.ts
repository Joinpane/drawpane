export type ClassValue = string | false | null | undefined | 0;

/** Joins the truthy class names: `cx("dp-btn", selected && "is-selected")`. */
export function cx(...classes: ClassValue[]): string {
  return classes.filter(Boolean).join(" ");
}
