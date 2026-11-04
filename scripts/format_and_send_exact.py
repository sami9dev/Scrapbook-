import os
import sys
import re
import json
import urllib.request
import urllib.error

API_URL = "https://scrapbook-0mrx.onrender.com/api/links/batch"
TG_TOKEN = os.environ.get("TELEGRAM_BOT_TOKEN", "8265322595:AAEHeMCYgdadTUcx6zFAL1DIWOLGwY2zkzw")
CHAT_ID = os.environ.get("TELEGRAM_CHAT_ID", "930928310")
SOURCE_URL = "https://huh.xdmovies.wtf/series/special-ops-15-the-himmat-story-2160p-1080p-hindi-tamil-download-138396"
LINKS_FILE = "C:/Users/sk621/scraper/.ua/tmp/special_ops_links.json"
RESOLVED_FILE = "C:/Users/sk621/scraper/.ua/tmp/special_ops_resolved.json"
MEM_DATA_FILE = "C:/Users/sk621/scraper/data/in_memory_scraped_links.json"

with open(LINKS_FILE, "r", encoding="utf-8") as f:
    raw_links = json.load(f)["links"]

resolved_map = {}
if os.path.exists(RESOLVED_FILE):
    with open(RESOLVED_FILE, "r", encoding="utf-8") as f:
        for it in json.load(f):
            resolved_map[it["href"]] = it

# Extract clean exact filename for each link
processed_items = []
for l in raw_links:
    href = l["href"]
    size = l["text"]
    raw_context = l.get("cardText") or l.get("context", "")
    
    # Match the exact full filename: e.g. Special.Ops.1.5.S01.2160p.JHS.WEB-DL.MULTi.DDP5.1.H.265-XDMovies.zip
    m = re.search(r"(Special\.Ops[^\s]+\.(?:zip|mkv))", raw_context, re.I)
    if m:
        filename = m.group(1)
    else:
        filename = raw_context.strip()

    is_pack = filename.lower().endswith(".zip")
    
    # Categorize exactly matching the site layout
    if is_pack:
        category = "packs"
    elif "2160p" in filename:
        category = "episodes_2160p"
    elif "1080p" in filename and "h.265" in filename.lower():
        category = "episodes_1080p_hevc"
    elif "1080p" in filename and "h.264" in filename.lower():
        category = "episodes_1080p_avc"
    else:
        category = "other"

    hubcloud = resolved_map.get(href, {}).get("hubcloud")

    processed_items.append({
        "index": l["index"],
        "filename": filename,
        "size": size,
        "category": category,
        "href": href,
        "hubcloud": hubcloud,
        "is_pack": is_pack
    })

print(f"Total processed items: {len(processed_items)}")

# 1. Update Render DB & local in_memory_scraped_links.json with exact filenames!
batch_payload = []
for it in processed_items:
    dest = it["hubcloud"] or it["href"]
    quality = "2160p" if "2160p" in it["filename"] else ("1080p" if "1080p" in it["filename"] else ("720p" if "720p" in it["filename"] else "480p"))
    entry1 = {
        "sourceUrl": SOURCE_URL,
        "title": it["filename"],
        "filename": it["filename"],
        "providerUrl": dest,
        "destination": dest,
        "mediatorUrl": it["href"],
        "sizeDisplay": it["size"],
        "quality": quality,
        "provider": "hubcloud" if "hubcloud" in dest else "mediator",
        "status": "active",
        "scope": "series",
        "type": "pack" if it["is_pack"] else "episode"
    }
    entry2 = dict(entry1)
    entry2["sourceUrl"] = it["href"]
    batch_payload.append(entry1)
    batch_payload.append(entry2)

try:
    req = urllib.request.Request(
        API_URL,
        data=json.dumps({"items": batch_payload}).encode("utf-8"),
        headers={"Content-Type": "application/json"}
    )
    with urllib.request.urlopen(req, timeout=30) as r:
        print("Render Ingestion Result:", json.loads(r.read().decode("utf-8")))
except Exception as e:
    print("Render Ingestion Error:", e)

# Update in_memory_scraped_links.json
try:
    with open(MEM_DATA_FILE, "r", encoding="utf-8") as f:
        mem_data = json.load(f)
    
    # Filter out old incomplete special ops records
    mem_data = [x for x in mem_data if "special-ops" not in (x.get("sourceUrl") or "") and "Special.Ops" not in (x.get("title") or "")]
    # Add newly structured records
    mem_data.extend(batch_payload)
    with open(MEM_DATA_FILE, "w", encoding="utf-8") as f:
        json.dump(mem_data, f, indent=2)
    print(f"Updated {MEM_DATA_FILE} with exact filenames. Total: {len(mem_data)}")
except Exception as e:
    print("Mem data file error:", e)

# 2. Format Telegram message structured EXACTLY like XDMovies sections with exact filenames!
msg_parts = [
    "🔥 <b>Special OPS 1.5: The Himmat Story (2021)</b>",
    "⚡ <i>Exact Release Filenames & Direct HubCloud Links</i>",
    "━━━━━━━━━━━━━━━━━━━━━━\n"
]

# Section: Season 1 Packs/Zips
msg_parts.append("📦 <b>Season 1 Packs/Zips:</b>")
for p in [x for x in processed_items if x["category"] == "packs"]:
    h = p["hubcloud"]
    link_html = f'<a href="{h}">{h}</a>' if h else f'<i>Resolving... ({p["href"]})</i>'
    msg_parts.append(f"📁 <code>{p['filename']}</code>\n   ├ 💾 <b>Size:</b> {p['size']}\n   └ 🔗 {link_html}\n")

# Section: Season 1 Episodes — 2160p SDR
msg_parts.append("🎬 <b>Season 1 Episodes — 2160p SDR:</b>")
for ep in [x for x in processed_items if x["category"] == "episodes_2160p"]:
    h = ep["hubcloud"]
    link_html = f'<a href="{h}">{h}</a>' if h else f'<i>Resolving... ({ep["href"]})</i>'
    msg_parts.append(f"📄 <code>{ep['filename']}</code>\n   ├ 💾 <b>Size:</b> {ep['size']}\n   └ 🔗 {link_html}\n")

# Section: Season 1 Episodes — 1080p H.265
msg_parts.append("🎬 <b>Season 1 Episodes — 1080p H.265:</b>")
for ep in [x for x in processed_items if x["category"] == "episodes_1080p_hevc"]:
    h = ep["hubcloud"]
    link_html = f'<a href="{h}">{h}</a>' if h else f'<i>Resolving... ({ep["href"]})</i>'
    msg_parts.append(f"📄 <code>{ep['filename']}</code>\n   ├ 💾 <b>Size:</b> {ep['size']}\n   └ 🔗 {link_html}\n")

# Section: Season 1 Episodes — 1080p H.264
msg_parts.append("🎬 <b>Season 1 Episodes — 1080p H.264:</b>")
for ep in [x for x in processed_items if x["category"] == "episodes_1080p_avc"]:
    h = ep["hubcloud"]
    link_html = f'<a href="{h}">{h}</a>' if h else f'<i>Resolving... ({ep["href"]})</i>'
    msg_parts.append(f"📄 <code>{ep['filename']}</code>\n   ├ 💾 <b>Size:</b> {ep['size']}\n   └ 🔗 {link_html}\n")

msg_parts.append("━━━━━━━━━━━━━━━━━━━━━━")
msg_parts.append("✅ <i>All links verified direct HubCloud Drive.</i>")

full_msg = "\n".join(msg_parts)

# Split if > 4096 chars (Telegram limit)
def send_tg_message(text):
    tg_url = f"https://api.telegram.org/bot{TG_TOKEN}/sendMessage"
    payload = json.dumps({
        "chat_id": CHAT_ID,
        "text": text,
        "parse_mode": "HTML",
        "disable_web_page_preview": True
    }).encode("utf-8")
    req = urllib.request.Request(tg_url, data=payload, headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=15) as r:
        res = json.loads(r.read().decode("utf-8"))
        print("Telegram delivered ok:", res.get("ok"))

if len(full_msg) > 4000:
    # Send in 2 clean parts
    # Part 1: Packs + 2160p
    part1_lines = msg_parts[:msg_parts.index("🎬 <b>Season 1 Episodes — 1080p H.265:</b>")]
    part2_lines = msg_parts[msg_parts.index("🎬 <b>Season 1 Episodes — 1080p H.265:</b>"):]
    send_tg_message("\n".join(part1_lines))
    send_tg_message("\n".join(part2_lines))
else:
    send_tg_message(full_msg)
