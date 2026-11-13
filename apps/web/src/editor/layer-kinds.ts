/** What each layer type is called and drawn as, everywhere the app names a layer. */
import type { LayerType } from "@drawpane/model";
import type { IconName } from "@drawpane/ui";

export const LAYER_KINDS: Readonly<Record<LayerType, { label: string; icon: IconName }>> = {
  frame: { label: "Frame", icon: "board" },
  group: { label: "Group", icon: "group" },
  rect: { label: "Rectangle", icon: "rectangle" },
  ellipse: { label: "Ellipse", icon: "ellipse" },
  polygon: { label: "Polygon", icon: "polygon" },
  star: { label: "Star", icon: "star" },
  line: { label: "Line", icon: "minus" },
  path: { label: "Vector", icon: "pen" },
  text: { label: "Text", icon: "text" },
};

export function layerKind(type: string): { label: string; icon: IconName } {
  return LAYER_KINDS[type as LayerType] ?? { label: "Layer", icon: "rectangle" };
}
