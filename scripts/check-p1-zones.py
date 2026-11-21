"""Measure the system TZif files from one identified tree at a fixed UTC instant."""
from datetime import datetime, timezone
import json
from pathlib import Path
import re
import sys
from zoneinfo import TZPATH, ZoneInfo

root = next((Path(p) for p in TZPATH if (Path(p) / "tzdata.zi").is_file()), None)
if root is None:
    raise SystemExit("System TZif directory with tzdata.zi required")
with (root / "tzdata.zi").open(encoding="utf-8") as f:
    version = re.fullmatch(r"# version ([0-9]{4}[a-z]+)", f.readline().strip())
if version is None:
    raise SystemExit("System tzdata version unknown")
catalogue = json.loads((Path(__file__).resolve().parents[1] / "prototypes/p1-zones/catalogue.json").read_text())
instant = datetime(2026, 11, 2, 12, tzinfo=timezone.utc)
offsets = {}
for name in [*catalogue["zones"], *catalogue["links"]]:
    try:
        with (root / name).open("rb") as f:
            zone = ZoneInfo.from_file(f, key=name)
    except FileNotFoundError:
        offsets[name] = None
        continue
    offsets[name] = int(instant.astimezone(zone).utcoffset().total_seconds())
print(json.dumps({"tzdata_version": version[1], "offsets": offsets, "python": sys.version.split()[0]}))
