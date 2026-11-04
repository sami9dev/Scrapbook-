import sys
import os
import time
import json
import urllib.request
import urllib.error

sys.path.append("C:/Users/sk621/scraper/src/scrapers/xdmovies")
from scrapling_resolver import resolve_mediator

SOURCE_URL = "https://huh.xdmovies.wtf/series/special-ops-15-the-himmat-story-2160p-1080p-hindi-tamil-download-138396"
LINKS_FILE = "C:/Users/sk621/scraper/.ua/tmp/special_ops_links.json"
RESOLVED_FILE = "C:/Users/sk621/scraper/.ua/tmp/special_ops_resolved.json"

with open(LINKS_FILE, "r", encoding="utf-8") as f:
    data = json.load(f)

links = data["links"]

# Load existing resolved
resolved_map = {}
if os.path.exists(RESOLVED_FILE):
    try:
        with open(RESOLVED_FILE, "r", encoding="utf-8") as f:
            existing = json.load(f)
            for item in existing:
                resolved_map[item["href"]] = item
    except Exception:
        pass

# Hardcode known solved
resolved_map["https://link.xdmovies.wtf/download/9GoXHJunESjUl814AHrXbLt13TMJbN_MY51r3bm6uDA"] = {
    "index": 3,
    "href": "https://link.xdmovies.wtf/download/9GoXHJunESjUl814AHrXbLt13TMJbN_MY51r3bm6uDA",
    "hubcloud": "https://hubcloud.ist/drive/sw3h3phh8kdkhk9",
    "text": "5.13 GB",
    "context": "Special.Ops.1.5.S01.1080p.JHS.WEB-DL.MULTi.DDP5.1.H.264-XDMovies.zip",
    "type": "pack",
    "quality": "1080p"
}

# Prioritize packs first (index 1, 2, 4), then 1080p episodes (9-16), then 2160p episodes (5-8)
priority_indices = [1, 2, 4, 9, 10, 11, 12, 13, 14, 15, 16, 5, 6, 7, 8]
sorted_links = sorted(links, key=lambda l: priority_indices.index(l["index"]) if l["index"] in priority_indices else 99)

for link in sorted_links:
    href = link["href"]
    idx = link["index"]
    ctx = link["context"]
    size = link["text"]

    is_pack = ".zip" in ctx.lower()
    quality = "2160p" if "2160p" in ctx else ("1080p" if "1080p" in ctx else ("720p" if "720p" in ctx else "480p"))

    if href in resolved_map and resolved_map[href].get("hubcloud"):
        print(f"[#{idx}] Already resolved: {resolved_map[href]['hubcloud']}")
        continue

    print(f"\n[#{idx}] Resolving: {ctx} ({size}) -> {href}...")
    try:
        res = resolve_mediator(href)
        hubcloud = res.get("destination")
        print(f" -> Result: {res.get('success')} | HubCloud: {hubcloud} | Elapsed: {res.get('elapsedMs')}ms")
        
        resolved_map[href] = {
            "index": idx,
            "href": href,
            "hubcloud": hubcloud,
            "text": size,
            "context": ctx,
            "type": "pack" if is_pack else "episode",
            "quality": quality,
            "isDead": res.get("isDead", False)
        }

        # Save checkpoint
        with open(RESOLVED_FILE, "w", encoding="utf-8") as f:
            json.dump(list(resolved_map.values()), f, indent=2)

    except Exception as e:
        print(f" -> Error resolving #{idx}: {e}")

print("\nAll target resolutions finished!")
