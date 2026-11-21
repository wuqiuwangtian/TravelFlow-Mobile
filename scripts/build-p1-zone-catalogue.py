"""Emit the pinned IANA default-build Zone/Link names from a verified local tarball."""
import hashlib
import json
import sys
import tarfile
from pathlib import Path

RELEASE = "2026f"
SHA256 = "01b4a91cec5167ed48c11e8ab78f2048cead78ce94b0cafcad0ae8c5a3044d3d"
FILES = "africa antarctica asia australasia europe northamerica southamerica etcetera factory backward".split()


def catalogue(path):
    if hashlib.sha256(path.read_bytes()).hexdigest() != SHA256:
        raise ValueError("tzdata archive SHA-256 mismatch")
    zones, links = set(), {}
    with tarfile.open(path, "r:gz") as archive:
        if archive.extractfile("version").read().decode().strip() != RELEASE:
            raise ValueError("tzdata version mismatch")
        for name in FILES:
            for line in archive.extractfile(name).read().decode().splitlines():
                fields = line.partition("#")[0].split()
                if fields[:1] not in (["Zone"], ["Link"]):
                    continue
                key = fields[1] if fields[0] == "Zone" else fields[2]
                if key in zones or key in links:
                    raise ValueError(f"duplicate name {key}")
                if fields[0] == "Zone":
                    zones.add(key)
                else:
                    links[key] = fields[1]
    if set(links.values()) - zones:
        raise ValueError("unresolved Link target")
    return {"release": RELEASE, "archive_url": f"https://data.iana.org/time-zones/releases/tzdata{RELEASE}.tar.gz",
            "archive_sha256": SHA256, "source_files": FILES, "zones": sorted(zones),
            "links": {name: links[name] for name in sorted(links)}}


if __name__ == "__main__":
    if len(sys.argv) != 2:
        raise SystemExit("Usage: python3 scripts/build-p1-zone-catalogue.py tzdata2026f.tar.gz")
    print(json.dumps(catalogue(Path(sys.argv[1])), indent=2))
