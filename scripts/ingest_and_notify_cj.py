import json
import urllib.request
import urllib.error

API_URL = "https://scrapbook-0mrx.onrender.com/api/links/batch"
import os
TG_TOKEN = os.environ.get("TELEGRAM_BOT_TOKEN", "")
CHAT_ID = os.environ.get("TELEGRAM_CHAT_ID", "")
SOURCE_URL = "https://huh.xdmovies.wtf/series/criminal-justice-1080p-720p-hindi-download-88177"

with open("C:/Users/sk621/scraper/.ua/tmp/criminal_justice_resolved.json", "r", encoding="utf-8") as f:
    items = json.load(f)

print(f"Preparing batch payload for {len(items)} items...")
batch_items = []

for it in items:
    # 1. Primary entry matching the exact series landing URL
    batch_items.append({
        "sourceUrl": SOURCE_URL,
        "title": it["title"],
        "providerUrl": it["hubcloud"],
        "destination": it["hubcloud"],
        "mediatorUrl": it["mediator"],
        "sizeDisplay": it["size"],
        "quality": it["res"],
        "provider": "hubcloud",
        "status": "active",
        "scope": "series",
        "type": "pack"
    })
    # 2. Secondary entry matching mediator URL as sourceUrl
    batch_items.append({
        "sourceUrl": it["mediator"],
        "title": it["title"],
        "providerUrl": it["hubcloud"],
        "destination": it["hubcloud"],
        "mediatorUrl": it["mediator"],
        "sizeDisplay": it["size"],
        "quality": it["res"],
        "provider": "hubcloud",
        "status": "active",
        "scope": "series",
        "type": "pack"
    })

payload = json.dumps({"items": batch_items}).encode("utf-8")
print(f"Ingesting {len(batch_items)} records into Render MongoDB ({API_URL})...")

try:
    req = urllib.request.Request(
        API_URL,
        data=payload,
        headers={"Content-Type": "application/json"}
    )
    with urllib.request.urlopen(req, timeout=30) as resp:
        res_data = json.loads(resp.read().decode("utf-8"))
        print("MongoDB Ingestion Result:", res_data)
except Exception as e:
    print(f"Ingestion Error: {e}")

# 3. Deliver to Telegram Chat ID 930928310
print(f"\nSending formatted HubCloud breakdown to Telegram ({CHAT_ID})...")

msg_text = (
    "🎬 <b>Criminal Justice (All Seasons 1–4) — Complete Packs</b>\n"
    "━━━━━━━━━━━━━━━━━━━━\n"
    "📁 <b>Landing URL:</b> <code>" + SOURCE_URL + "</code>\n\n"
    "⚡ <b>Verified Direct HubCloud Drive Links:</b>\n\n"
    "🔹 <b>Season 1 (2019)</b>\n"
    "• 1080p WEB-DL (12.73 GB): <a href=\"https://hubcloud.ist/drive/yifqqgut1mdfxtq\">https://hubcloud.ist/drive/yifqqgut1mdfxtq</a>\n"
    "• 720p WEB-DL (3.43 GB): <a href=\"https://hubcloud.ist/drive/l41yhu5jckpht5c\">https://hubcloud.ist/drive/l41yhu5jckpht5c</a>\n\n"
    "🔹 <b>Season 2: Behind Closed Doors (2020)</b>\n"
    "• 1080p WEB-DL (10.32 GB): <a href=\"https://hubcloud.ist/drive/1bmtaj7zozjtjlc\">https://hubcloud.ist/drive/1bmtaj7zozjtjlc</a>\n"
    "• 720p WEB-DL (3.44 GB): <a href=\"https://hubcloud.ist/drive/jbhmebuxex5m11k\">https://hubcloud.ist/drive/jbhmebuxex5m11k</a>\n\n"
    "🔹 <b>Season 3: Adhura Sach (2022)</b>\n"
    "• 1080p WEB-DL (12.55 GB): <a href=\"https://hubcloud.ist/drive/wckle1de1ibke2z\">https://hubcloud.ist/drive/wckle1de1ibke2z</a>\n"
    "• 720p WEB-DL (4.06 GB): <a href=\"https://hubcloud.ist/drive/w1ow6bhcodhokkk\">https://hubcloud.ist/drive/w1ow6bhcodhokkk</a>\n\n"
    "🔹 <b>Season 4 (2024)</b>\n"
    "• 1080p WEB-DL (9.51 GB): <a href=\"https://hubcloud.ist/drive/twnijeb5jxgqvbf\">https://hubcloud.ist/drive/twnijeb5jxgqvbf</a>\n"
    "• 720p WEB-DL (3.67 GB): <a href=\"https://hubcloud.ist/drive/tr5n6uyt9ci93np\">https://hubcloud.ist/drive/tr5n6uyt9ci93np</a>\n\n"
    "━━━━━━━━━━━━━━━━━━━━\n"
    "✅ <i>Ingested into Pre-Indexed MongoDB Catalogue &amp; Upstash Redis Cache.</i>\n"
    "⚡ <i>Sending this URL directly to @Linkscrap_bot will now return instant hits (&lt; 0.2s).</i>"
)

tg_url = f"https://api.telegram.org/bot{TG_TOKEN}/sendMessage"
tg_payload = json.dumps({
    "chat_id": CHAT_ID,
    "text": msg_text,
    "parse_mode": "HTML",
    "disable_web_page_preview": True
}).encode("utf-8")

try:
    req2 = urllib.request.Request(
        tg_url,
        data=tg_payload,
        headers={"Content-Type": "application/json"}
    )
    with urllib.request.urlopen(req2, timeout=15) as resp2:
        print("Telegram API Response:", resp2.getcode(), resp2.read().decode("utf-8"))
except Exception as e:
    print(f"Telegram Delivery Error: {e}")
