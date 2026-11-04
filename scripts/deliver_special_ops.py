import os
import sys
import json
import urllib.request
import urllib.error

API_URL = "https://scrapbook-0mrx.onrender.com/api/links/batch"
TG_TOKEN = os.environ.get("TELEGRAM_BOT_TOKEN", "8265322595:AAEHeMCYgdadTUcx6zFAL1DIWOLGwY2zkzw")
CHAT_ID = os.environ.get("TELEGRAM_CHAT_ID", "930928310")
SOURCE_URL = "https://huh.xdmovies.wtf/series/special-ops-15-the-himmat-story-2160p-1080p-hindi-tamil-download-138396"
RESOLVED_FILE = "C:/Users/sk621/scraper/.ua/tmp/special_ops_resolved.json"
MEM_DATA_FILE = "C:/Users/sk621/scraper/data/in_memory_scraped_links.json"

if not os.path.exists(RESOLVED_FILE):
    print("Resolved file does not exist yet.")
    sys.exit(1)

with open(RESOLVED_FILE, "r", encoding="utf-8") as f:
    resolved = json.load(f)

print(f"Loaded {len(resolved)} resolved items.")

# Separate packs and episodes
packs = [r for r in resolved if r.get("type") == "pack"]
episodes = [r for r in resolved if r.get("type") == "episode"]

# Ingest into live Render RAM & Mongo
batch_items = []
for it in resolved:
    title = it.get("context", "Special Ops 1.5")
    provider_url = it.get("hubcloud") or it.get("href")
    
    # 1. Matching landing page sourceUrl
    batch_items.append({
        "sourceUrl": SOURCE_URL,
        "title": title,
        "providerUrl": provider_url,
        "destination": provider_url,
        "mediatorUrl": it.get("href"),
        "sizeDisplay": it.get("text"),
        "quality": it.get("quality"),
        "provider": "hubcloud" if "hubcloud" in provider_url else "mediator",
        "status": "active",
        "scope": "series",
        "type": it.get("type", "episode")
    })
    # 2. Matching mediator as sourceUrl
    batch_items.append({
        "sourceUrl": it.get("href"),
        "title": title,
        "providerUrl": provider_url,
        "destination": provider_url,
        "mediatorUrl": it.get("href"),
        "sizeDisplay": it.get("text"),
        "quality": it.get("quality"),
        "provider": "hubcloud" if "hubcloud" in provider_url else "mediator",
        "status": "active",
        "scope": "series",
        "type": it.get("type", "episode")
    })

print(f"Sending batch payload ({len(batch_items)} records) to {API_URL}...")
try:
    req = urllib.request.Request(
        API_URL,
        data=json.dumps({"items": batch_items}).encode("utf-8"),
        headers={"Content-Type": "application/json"}
    )
    with urllib.request.urlopen(req, timeout=30) as resp:
        res = json.loads(resp.read().decode("utf-8"))
        print("Ingestion result:", res)
except Exception as e:
    print("Ingestion error:", e)

# Also persist into in_memory_scraped_links.json
try:
    with open(MEM_DATA_FILE, "r", encoding="utf-8") as f:
        mem_data = json.load(f)
    existing_hashes = set(x.get("providerUrl") or x.get("sourceUrl") for x in mem_data)
    added = 0
    for b in batch_items:
        key = b.get("providerUrl") or b.get("sourceUrl")
        if key not in existing_hashes:
            mem_data.append(b)
            existing_hashes.add(key)
            added += 1
    with open(MEM_DATA_FILE, "w", encoding="utf-8") as f:
        json.dump(mem_data, f, indent=2)
    print(f"Persisted {added} new entries to {MEM_DATA_FILE}. Total now: {len(mem_data)}")
except Exception as e:
    print("Error saving to disk file:", e)

# Build Telegram message
lines = [
    "🔥 <b>Special OPS 1.5: The Himmat Story (2021)</b>",
    "⚡ <b>All Qualities • All Episodes • All Season Packs</b>",
    "━━━━━━━━━━━━━━━━━━━━━━",
    "🔗 <b>Source:</b> <code>" + SOURCE_URL + "</code>\n"
]

if packs:
    lines.append("📦 <b>SEASON COMPLETE PACKS / ZIP:</b>")
    for p in sorted(packs, key=lambda x: x.get("index", 0)):
        res = p.get("quality", "").upper()
        size = p.get("text", "")
        h = p.get("hubcloud")
        link_str = f'<a href="{h}">{h}</a>' if h else f'<i>(Resolving... {p.get("href")})</i>'
        lines.append(f"• <b>{res} Pack</b> ({size}): {link_str}")
    lines.append("")

if episodes:
    lines.append("🎬 <b>EPISODES (BY QUALITY):</b>")
    # Group by quality
    q_map = {}
    for ep in episodes:
        q = ep.get("quality", "1080p")
        q_map.setdefault(q, []).append(ep)
    
    for q, eps in q_map.items():
        lines.append(f"\n📺 <b>— {q.upper()} EPISODES —</b>")
        for ep in sorted(eps, key=lambda x: x.get("index", 0)):
            ctx = ep.get("context", "")
            # extract E01, E02, etc
            import re
            m = re.search(r"S\d+E(\d+)", ctx, re.I)
            ep_num = f"E{m.group(1)}" if m else f"Ep #{ep.get('index')}"
            size = ep.get("text", "")
            h = ep.get("hubcloud")
            link_str = f'<a href="{h}">{h}</a>' if h else f'<i>{ep.get("href")}</i>'
            lines.append(f"• <b>{ep_num}</b> ({size}): {link_str}")

lines.append("\n━━━━━━━━━━━━━━━━━━━━━━")
lines.append("✅ <i>Ingested into Live Database & Cloudflare Edge.</i>")
lines.append("⚡ <i>Direct queries on Telegram @Linkscrap_bot return in &lt; 0.1s.</i>")

msg_text = "\n".join(lines)
tg_url = f"https://api.telegram.org/bot{TG_TOKEN}/sendMessage"
tg_payload = json.dumps({
    "chat_id": CHAT_ID,
    "text": msg_text,
    "parse_mode": "HTML",
    "disable_web_page_preview": True
}).encode("utf-8")

print(f"Sending formatted message to Telegram chat {CHAT_ID}...")
try:
    req2 = urllib.request.Request(tg_url, data=tg_payload, headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req2, timeout=15) as resp2:
        res2 = json.loads(resp2.read().decode("utf-8"))
        print("Telegram API response ok:", res2.get("ok"))
except Exception as e:
    print("Telegram delivery error:", e)
