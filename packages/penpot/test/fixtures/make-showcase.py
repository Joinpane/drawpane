"""
Builds showcase.penpot: a .penpot (binfile v3) export written by hand to the
format Penpot's exporter produces (see backend/src/app/binfile/v3.clj), with
what the upstream samples lack: text with styled runs, an image fill, flex
layout, a rotated layer, a gradient, a stroked path with an arrow, a masked
group, a component with a copy, library colours and typographies, and two
pages with a prototype link. Run: python3 make-showcase.py
"""
import json
import struct
import zipfile
import zlib
from pathlib import Path

ROOT = "00000000-0000-0000-0000-000000000000"


def uid(n: int) -> str:
    return f"5b1f0c3a-0000-4000-8000-{n:012d}"


FILE = uid(1)
P1 = uid(2)
P2 = uid(3)
MEDIA = uid(4)
STORAGE = uid(5)
COLOR = uid(6)
TYPO = uid(7)
COMP = uid(8)


def png(width: int, height: int) -> bytes:
    """A small gradient PNG, so the image fill has something to show."""
    rows = b""
    for y in range(height):
        row = b"\x00"
        for x in range(width):
            row += bytes([224, 79 + (y * 120 // height), 26 + (x * 160 // width)])
        rows += row

    def chunk(kind: bytes, data: bytes) -> bytes:
        body = kind + data
        return struct.pack(">I", len(data)) + body + struct.pack(">I", zlib.crc32(body) & 0xFFFFFFFF)

    header = struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", header) + chunk(b"IDAT", zlib.compress(rows)) + chunk(b"IEND", b"")


def box(x, y, w, h, rotation=0.0):
    import math

    r = math.radians(rotation)
    a, b, c, d = math.cos(r), math.sin(r), -math.sin(r), math.cos(r)
    cx, cy = x + w / 2, y + h / 2

    def pt(px, py):
        dx, dy = px - cx, py - cy
        return {"x": cx + a * dx + c * dy, "y": cy + b * dx + d * dy}

    return {
        "x": x,
        "y": y,
        "width": w,
        "height": h,
        "rotation": rotation,
        "selrect": {"x": x, "y": y, "width": w, "height": h, "x1": x, "y1": y, "x2": x + w, "y2": y + h},
        "points": [pt(x, y), pt(x + w, y), pt(x + w, y + h), pt(x, y + h)],
        "transform": {"a": a, "b": b, "c": c, "d": d, "e": 0, "f": 0},
        "transformInverse": {"a": a, "b": -b, "c": -c, "d": d, "e": 0, "f": 0},
    }


def shape(id, type, name, parent, frame, page, **extra):
    return {"id": id, "type": type, "name": name, "parentId": parent, "frameId": frame, "pageId": page, **extra}


def leaf(text, **extra):
    base = {
        "text": text,
        "fontId": "gfont-inter",
        "fontFamily": "Inter",
        "fontVariantId": "regular",
        "fontSize": "16",
        "fontWeight": "400",
        "fontStyle": "normal",
        "lineHeight": "1.4",
        "letterSpacing": "0",
        "textTransform": "none",
        "textDecoration": "none",
        "fills": [{"fillColor": "#1C1B1A", "fillOpacity": 1}],
    }
    base.update(extra)
    return base


def text_content(paragraphs, align="left"):
    return {
        "type": "root",
        "verticalAlign": "top",
        "children": [
            {
                "type": "paragraph-set",
                "children": [
                    {"type": "paragraph", "textAlign": align, "lineHeight": "1.4", "children": leaves}
                    for leaves in paragraphs
                ],
            }
        ],
    }


shapes1 = []
card = uid(10)
heading = uid(11)
body = uid(12)
photo = uid(13)
row = uid(14)
chip_a = uid(15)
chip_b = uid(16)
tilted = uid(17)
dot = uid(18)
arrow = uid(19)
masked = uid(20)
mask = uid(21)
masked_img = uid(22)
main = uid(23)
main_label = uid(24)
copy = uid(25)
copy_label = uid(26)

shapes1.append(
    shape(ROOT, "frame", "Root Frame", ROOT, ROOT, P1, **box(0, 0, 0.01, 0.01),
          fills=[{"fillColor": "#FFFFFF", "fillOpacity": 1}],
          shapes=[card, tilted, dot, arrow, masked, main, copy])
)
shapes1.append(
    shape(card, "frame", "Card", ROOT, ROOT, P1, **box(0, 0, 360, 420),
          fills=[{"fillColor": "#FFFFFF", "fillOpacity": 1}],
          strokes=[{"strokeColor": "#E3E1DC", "strokeOpacity": 1, "strokeWidth": 1, "strokeAlignment": "inner"}],
          r1=16, r2=16, r3=16, r4=16,
          shadow=[{"id": uid(90), "style": "drop-shadow", "offsetX": 0, "offsetY": 8, "blur": 24, "spread": 0,
                   "hidden": False, "color": {"color": "#000000", "opacity": 0.12}}],
          layout="flex", layoutFlexDir="column", layoutGap={"rowGap": 12, "columnGap": 0},
          layoutPadding={"p1": 24, "p2": 24, "p3": 24, "p4": 24}, layoutPaddingType="multiple",
          layoutAlignItems="start", layoutJustifyContent="start",
          # Flex flows topmost first: the photo (last) leads.
          shapes=[row, body, heading, photo],
          interactions=[{"eventType": "click", "actionType": "navigate", "destination": uid(40),
                         "preserveScroll": False,
                         "animation": {"animationType": "dissolve", "duration": 300, "easing": "ease-out"}}])
)
shapes1.append(
    shape(photo, "rect", "Photo", card, card, P1, **box(24, 24, 312, 160), r1=10, r2=10, r3=10, r4=10,
          fills=[{"fillImage": {"id": MEDIA, "width": 64, "height": 32, "mtype": "image/png", "name": "sunset",
                                "keepAspectRatio": True}}],
          layoutItemHSizing="fill")
)
shapes1.append(
    shape(heading, "text", "Heading", card, card, P1, **box(24, 196, 312, 34), growType="auto-height",
          content=text_content([[leaf("Plan your ", fontSize="26", fontWeight="700", typographyRefId=TYPO,
                                      typographyRefFile=FILE),
                                 leaf("week", fontSize="26", fontWeight="700",
                                      fills=[{"fillColor": "#E8590C", "fillOpacity": 1}])]]))
)
shapes1.append(
    shape(body, "text", "Body", card, card, P1, **box(24, 242, 312, 66), growType="auto-height",
          content=text_content([[leaf("Three things on today, "), leaf("nothing more", fontStyle="italic",
                                                                       textDecoration="underline"),
                                 leaf(". Pick the one that matters and do it first.")]]))
)
shapes1.append(
    shape(row, "frame", "Tags", card, card, P1, **box(24, 320, 312, 28),
          layout="flex", layoutFlexDir="row", layoutGap={"rowGap": 0, "columnGap": 8},
          layoutPadding={"p1": 0, "p2": 0, "p3": 0, "p4": 0}, layoutAlignItems="center",
          layoutItemHSizing="fill", showContent=True,
          shapes=[chip_b, chip_a])
)
for i, (cid, label, x) in enumerate([(chip_a, "Focus", 24), (chip_b, "Today", 100)]):
    shapes1.append(
        shape(cid, "rect", label, row, row, P1, **box(x, 320, 68, 28), r1=14, r2=14, r3=14, r4=14,
              fills=[{"fillColor": "#007CA5" if i == 0 else "#F1EFE9", "fillOpacity": 1,
                      **({"fillColorRefId": COLOR, "fillColorRefFile": FILE} if i == 0 else {})}])
    )
shapes1.append(
    shape(tilted, "rect", "Tilted", ROOT, ROOT, P1, **box(440, 40, 120, 80, rotation=15),
          fills=[{"fillColorGradient": {"type": "linear", "startX": 0, "startY": 0, "endX": 1, "endY": 1, "width": 1,
                                        "stops": [{"color": "#E8590C", "opacity": 1, "offset": 0},
                                                  {"color": "#F2C94C", "opacity": 1, "offset": 1}]}}],
          r1=12, r2=12, r3=12, r4=12)
)
shapes1.append(
    shape(dot, "circle", "Dot", ROOT, ROOT, P1, **box(460, 170, 80, 80),
          fills=[{"fillColorGradient": {"type": "radial", "startX": 0.5, "startY": 0.5, "endX": 1, "endY": 0.5,
                                        "width": 1, "stops": [{"color": "#007CA5", "opacity": 1, "offset": 0},
                                                              {"color": "#007CA5", "opacity": 0, "offset": 1}]}}],
          blur={"id": uid(91), "type": "layer-blur", "value": 2, "hidden": False})
)
shapes1.append(
    shape(arrow, "path", "Arrow", ROOT, ROOT, P1, x=None, y=None, width=None, height=None,
          selrect={"x": 440, "y": 290, "width": 140, "height": 40},
          content="M440,330C480,290,540,290,580,310",
          strokes=[{"strokeColor": "#1C1B1A", "strokeOpacity": 1, "strokeWidth": 2, "strokeAlignment": "center",
                    "strokeStyle": "dashed", "strokeCapEnd": "triangle-arrow"}])
)
shapes1.append(
    shape(masked, "group", "Masked photo", ROOT, ROOT, P1, **box(620, 40, 120, 120), maskedGroup=True,
          shapes=[mask, masked_img])
)
shapes1.append(
    shape(mask, "circle", "Mask", masked, ROOT, P1, **box(620, 40, 120, 120),
          fills=[{"fillColor": "#000000", "fillOpacity": 1}])
)
shapes1.append(
    shape(masked_img, "rect", "Image", masked, ROOT, P1, **box(620, 40, 120, 120),
          fills=[{"fillImage": {"id": MEDIA, "width": 64, "height": 32, "mtype": "image/png",
                                "keepAspectRatio": True}}])
)
shapes1.append(
    shape(main, "frame", "Button", ROOT, ROOT, P1, **box(620, 220, 120, 40), r1=8, r2=8, r3=8, r4=8,
          fills=[{"fillColor": "#1C1B1A", "fillOpacity": 1}], componentId=COMP, componentFile=FILE,
          componentRoot=True, mainInstance=True, shapes=[main_label])
)
shapes1.append(
    shape(main_label, "text", "Label", main, main, P1, **box(642, 230, 76, 20), growType="auto-width",
          content=text_content([[leaf("Get started", fontSize="14", fontWeight="600",
                                      fills=[{"fillColor": "#FFFFFF", "fillOpacity": 1}])]], align="center"))
)
shapes1.append(
    shape(copy, "frame", "Button", ROOT, ROOT, P1, **box(620, 290, 120, 40), r1=8, r2=8, r3=8, r4=8,
          fills=[{"fillColor": "#E8590C", "fillOpacity": 1}], componentId=COMP, componentFile=FILE,
          componentRoot=True, touched=["fill-group"], shapes=[copy_label])
)
shapes1.append(
    shape(copy_label, "text", "Label", copy, copy, P1, **box(642, 300, 76, 20), growType="auto-width",
          shapeRef=main_label,
          content=text_content([[leaf("Get started", fontSize="14", fontWeight="600",
                                      fills=[{"fillColor": "#FFFFFF", "fillOpacity": 1}])]], align="center"))
)

done = uid(40)
done_text = uid(41)
shapes2 = [
    shape(ROOT, "frame", "Root Frame", ROOT, ROOT, P2, **box(0, 0, 0.01, 0.01),
          fills=[{"fillColor": "#FFFFFF", "fillOpacity": 1}], shapes=[done]),
    shape(done, "frame", "Done", ROOT, ROOT, P2, **box(0, 0, 360, 200),
          fills=[{"fillColor": "#F1EFE9", "fillOpacity": 1}], shapes=[done_text]),
    shape(done_text, "text", "Message", done, done, P2, **box(24, 24, 312, 40), growType="auto-height",
          content=text_content([[leaf("All done for today.", fontSize="22", fontWeight="600")]])),
]

out = Path(__file__).with_name("showcase.penpot")
image = png(64, 32)
with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
    def put(name, data):
        z.writestr(name, json.dumps(data, indent=2) if not isinstance(data, bytes) else data)

    put("manifest.json", {"type": "penpot/export-files", "version": 1, "generatedBy": "drawpane/test-fixture",
                          "referer": "penpot", "files": [{"id": FILE, "name": "Showcase", "features": []}],
                          "relations": []})
    put(f"files/{FILE}.json", {"id": FILE, "name": "Showcase", "revn": 1, "vern": 0, "version": 67,
                               "migrations": [], "features": [], "isShared": False,
                               "options": {"componentsV2": True, "baseFontSize": "16px"}})
    put(f"files/{FILE}/pages/{P1}.json", {"id": P1, "name": "Cover", "index": 0, "background": "#E9E7E2",
                                          "flows": {uid(80): {"id": uid(80), "name": "Main", "startingFrame": card}}})
    put(f"files/{FILE}/pages/{P2}.json", {"id": P2, "name": "Done", "index": 1})
    for s in shapes1:
        put(f"files/{FILE}/pages/{P1}/{s['id']}.json", s)
    for s in shapes2:
        put(f"files/{FILE}/pages/{P2}/{s['id']}.json", s)
    put(f"files/{FILE}/components/{COMP}.json", {"id": COMP, "name": "Button", "path": "", "mainInstanceId": main,
                                                 "mainInstancePage": P1})
    put(f"files/{FILE}/media/{MEDIA}.json", {"id": MEDIA, "name": "sunset", "width": 64, "height": 32,
                                             "mtype": "image/png", "mediaId": STORAGE, "isLocal": True})
    put(f"files/{FILE}/colors/{COLOR}.json", {"id": COLOR, "name": "Primary", "path": "Brand", "opacity": 1,
                                              "color": "#007ca5"})
    put(f"files/{FILE}/typographies/{TYPO}.json", {"id": TYPO, "name": "Heading", "path": "Titles",
                                                   "fontId": "gfont-inter", "fontFamily": "Inter",
                                                   "fontVariantId": "700", "fontSize": "26", "fontWeight": "700",
                                                   "fontStyle": "normal", "lineHeight": "1.4", "letterSpacing": "0",
                                                   "textTransform": "none"})
    put(f"objects/{STORAGE}.json", {"id": STORAGE, "bucket": "file-media-object", "contentType": "image/png",
                                    "size": len(image)})
    put(f"objects/{STORAGE}.png", image)
print(f"wrote {out} ({out.stat().st_size} bytes)")
