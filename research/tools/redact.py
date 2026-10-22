"""Fill redaction boxes (CSS px, scaled to device px) with a flat neutral grey; also writes a 1x copy."""
import json, sys
from PIL import Image, ImageDraw

src, boxes_path, out = sys.argv[1:4]
css_width = float(sys.argv[4]) if len(sys.argv) > 4 else 1280
im = Image.open(src).convert("RGB")
boxes = json.load(open(boxes_path)) if boxes_path != "-" else []
# Device scale: goldens are captured at DPR 2 for a 1280-wide viewport.
scale = im.width / css_width
d = ImageDraw.Draw(im)
for b in boxes:
    d.rectangle([b["x"] * scale, b["y"] * scale, (b["x"] + b["w"]) * scale, (b["y"] + b["h"]) * scale], fill=(200, 200, 204))
im.save(out)
im.resize((round(im.width / scale), round(im.height / scale)), Image.LANCZOS).save(out[:-4] + "-1x.png")
