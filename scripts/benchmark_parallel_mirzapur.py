import os
import sys
import time
import json
import urllib.request
import urllib.error
from concurrent.futures import ThreadPoolExecutor, as_completed

sys.path.append("C:/Users/sk621/scraper/src/scrapers/xdmovies")
from scrapling_resolver import resolve_mediator

SOURCE_URL = "https://huh.xdmovies.wtf/series/mirzapur-2160p-1080p-hindi-tamil-download-84105"
LINKS_FILE = "C:/Users/sk621/scraper/.ua/tmp/mirzapur_links.json"
API_URL = "https://scrapbook-0mrx.onrender.com/api/links/batch"
TG_TOKEN = os.environ.get("TELEGRAM_BOT_TOKEN", "8265322595:AAEHeMCYgdadTUcx6zFAL1DIWOLGwY2zkzw")
CHAT_ID = os.environ.get("TELEGRAM_CHAT_ID", "930928310")
MEM_DATA_FILE = "C:/Users/sk621/scraper/data/in_memory_scraped_links.json"

with open(LINKS_FILE, "r", encoding="utf-8") as f:
    all_links = json.load(f)["links"]

# Select the top 8 links: 4 Season 1 Packs + 4 S01 Episodes
target_8 = all_links[:8]

print(f"=== Starting Parallel Benchmark: 8 Links Concurrently ===")
for i, item in enumerate(target_8):
    print(f" Target #{i+1}: {item['filename']} ({item['text']})")

results = []

def solve_single(item):
    idx = item["index"]
    href = item["href"]
    filename = item["filename"]
    size = item["text"]
    t0 = time.perf_counter()
    print(f"\n[Worker START] #{idx}: {filename}...")
    try:
        res = resolve_mediator(href)
        elapsed = time.perf_counter() - t0
        dest = res.get("destination")
        success = res.get("success", False) and bool(dest)
        print(f"[Worker DONE] #{idx}: {filename} -> Success={success} in {elapsed:.2f}s | {dest}")
        return {
            "index": idx,
            "filename": filename,
            "size": size,
            "mediator": href,
            "hubcloud": dest,
            "success": success,
            "elapsed": elapsed,
            "error": res.get("error")
        }
    except Exception as e:
        elapsed = time.perf_counter() - t0
        print(f"[Worker ERROR] #{idx}: {filename} -> Error: {e} ({elapsed:.2f}s)")
        return {
            "index": idx,
            "filename": filename,
            "size": size,
            "mediator": href,
            "hubcloud": None,
            "success": False,
            "elapsed": elapsed,
            "error": str(e)
        }

wall_start = time.perf_counter()

# Run all 8 simultaneously with max_workers=8
with ThreadPoolExecutor(max_workers=8) as executor:
    futures = [executor.submit(solve_single, item) for item in target_8]
    for fut in as_completed(futures):
        results.append(fut.result())

total_wall_clock = time.perf_counter() - wall_start

# Sort back by original index
results = sorted(results, key=lambda x: target_8.index(next(t for t in target_8 if t["index"] == x["index"])))

sum_individual = sum(r["elapsed"] for r in results)
avg_time = sum_individual / len(results) if results else 0
speedup = sum_individual / total_wall_clock if total_wall_clock > 0 else 1

print("\n" + "="*60)
print(f"BENCHMARK RESULTS (8 Links in Parallel):")
print(f"Total Wall-Clock Time:   {total_wall_clock:.2f} seconds ({total_wall_clock/60:.2f} mins)")
print(f"Sum of Individual Times: {sum_individual:.2f} seconds ({sum_individual/60:.2f} mins)")
print(f"Average Time Per Link:   {avg_time:.2f} seconds")
print(f"Parallel Speedup Factor: {speedup:.2f}x faster than sequential")
print("="*60 + "\n")

# Ingest into Render RAM & local in_memory_scraped_links.json
batch_items = []
for r in results:
    dest = r["hubcloud"] or r["mediator"]
    quality = "2160p" if "2160p" in r["filename"] else ("1080p" if "1080p" in r["filename"] else "720p")
    entry = {
        "sourceUrl": SOURCE_URL,
        "title": r["filename"],
        "filename": r["filename"],
        "providerUrl": dest,
        "destination": dest,
        "mediatorUrl": r["mediator"],
        "sizeDisplay": r["size"],
        "quality": quality,
        "provider": "hubcloud" if "hubcloud" in dest else "mediator",
        "status": "active",
        "scope": "series",
        "type": "pack" if r["filename"].lower().endswith(".zip") else "episode"
    }
    batch_items.append(entry)
    entry2 = dict(entry)
    entry2["sourceUrl"] = r["mediator"]
    batch_items.append(entry2)

try:
    req = urllib.request.Request(
        API_URL,
        data=json.dumps({"items": batch_items}).encode("utf-8"),
        headers={"Content-Type": "application/json"}
    )
    with urllib.request.urlopen(req, timeout=30) as resp:
        print("Render Ingestion Result:", json.loads(resp.read().decode("utf-8")))
except Exception as e:
    print("Render Ingestion Error:", e)

# Save to disk
try:
    with open(MEM_DATA_FILE, "r", encoding="utf-8") as f:
        mem_data = json.load(f)
    existing_keys = set(x.get("providerUrl") or x.get("sourceUrl") for x in mem_data)
    added = 0
    for b in batch_items:
        key = b.get("providerUrl") or b.get("sourceUrl")
        if key not in existing_keys:
            mem_data.append(b)
            existing_keys.add(key)
            added += 1
    with open(MEM_DATA_FILE, "w", encoding="utf-8") as f:
        json.dump(mem_data, f, indent=2)
    print(f"Persisted {added} records to disk. Total now: {len(mem_data)}")
except Exception as e:
    print("Disk persist error:", e)

# Save results json
with open("C:/Users/sk621/scraper/.ua/tmp/mirzapur_parallel_results.json", "w", encoding="utf-8") as f:
    json.dump({
        "wallClockSeconds": total_wall_clock,
        "sumIndividualSeconds": sum_individual,
        "averageSeconds": avg_time,
        "speedup": speedup,
        "results": results
    }, f, indent=2)

# Build formatted Telegram message
tg_lines = [
    "🚀 <b>Mirzapur (Season 1) — Parallel 8-Worker Benchmark</b>",
    "⚡ <i>8 Links Solved Concurrently with Exact Filenames</i>",
    "━━━━━━━━━━━━━━━━━━━━━━",
    f"⏱ <b>Total Parallel Time:</b> <code>{total_wall_clock:.2f}s</code> ({total_wall_clock/60:.2f}m)",
    f"📈 <b>Sequential Equivalent:</b> <code>{sum_individual:.2f}s</code> ({sum_individual/60:.2f}m)",
    f"⚡ <b>Parallel Speedup:</b> <b>{speedup:.2f}x Faster!</b>",
    f"📊 <b>Average Time / Link:</b> <code>{avg_time:.2f}s</code>",
    "━━━━━━━━━━━━━━━━━━━━━━\n",
    "📦 <b>RESOLVED DIRECT HUBCLOUD LINKS:</b>\n"
]

for r in results:
    status_icon = "✅" if r["success"] else "⚠️"
    h = r["hubcloud"]
    link_str = f'<a href="{h}">{h}</a>' if h else f'<i>Failed ({r.get("error")})</i>'
    tg_lines.append(
        f"{status_icon} <code>{r['filename']}</code>\n"
        f"   ├ 💾 <b>Size:</b> {r['size']} | ⏱ <b>Time:</b> {r['elapsed']:.2f}s\n"
        f"   └ 🔗 {link_str}\n"
    )

tg_lines.append("━━━━━━━━━━━━━━━━━━━━━━")
tg_lines.append("✅ <i>All 8 links ingested into Database & Cloudflare Edge.</i>")

tg_text = "\n".join(tg_lines)

# Send to Telegram
def send_telegram(text):
    url = f"https://api.telegram.org/bot{TG_TOKEN}/sendMessage"
    payload = json.dumps({
        "chat_id": CHAT_ID,
        "text": text,
        "parse_mode": "HTML",
        "disable_web_page_preview": True
    }).encode("utf-8")
    req = urllib.request.Request(url, data=payload, headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=15) as r:
        d = json.loads(r.read().decode("utf-8"))
        print("Telegram delivery status ok:", d.get("ok"))

if len(tg_text) > 4000:
    mid = len(results) // 2
    part1_lines = tg_lines[:mid*4 + 7]
    part2_lines = tg_lines[mid*4 + 7:]
    send_telegram("\n".join(part1_lines))
    send_telegram("\n".join(part2_lines))
else:
    send_telegram(tg_text)
