import urllib.request
import json
import time
import os
import sys
import concurrent.futures

if hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(encoding='utf-8')

BASE_URL = "http://localhost:3000"
LOG_PREFIX = "[Auto-Resolver]"
FAILED_ATTEMPTS = {}
MAX_RETRIES = 2

def log(msg):
    ts = time.strftime("%Y-%m-%d %H:%M:%S")
    safe_msg = str(msg).encode('ascii', errors='replace').decode('ascii')
    print(f"[{ts}] {LOG_PREFIX} {safe_msg}", flush=True)

def fetch_links():
    try:
        url = f"{BASE_URL}/api/links?limit=500"
        req = urllib.request.Request(url, headers={"User-Agent": "AutoResolver/2.0"})
        with urllib.request.urlopen(req, timeout=15) as resp:
            data = json.loads(resp.read().decode("utf-8"))
            return data
    except Exception as e:
        log(f"Failed to fetch links from DB: {e}")
        return []

def is_resolved(item):
    status = item.get("status")
    p_url = item.get("providerUrl") or ""
    return status == "RESOLVED" and "hubcloud" in p_url and "/drive/" in p_url

def rank_item(item):
    """
    Ranks items so the most popular downloads resolve first:
    1. Season Packs (1080p, 720p)
    2. Movies (1080p, 720p, 2160p)
    3. Episodes (Season 1, Season 2...)
    """
    scope = (item.get("scope") or "").lower()
    quality = (item.get("quality") or "").lower()
    
    score = 100
    if scope == "pack":
        score -= 50
    elif scope == "movie":
        score -= 40
    else:
        score -= 10

    if "1080p" in quality:
        score -= 20
    elif "720p" in quality:
        score -= 15
    elif "2160p" in quality or "4k" in quality:
        score -= 10

    return score

def resolve_item(item_id, title):
    url = f"{BASE_URL}/api/resolve-link"
    data = json.dumps({"id": item_id}).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=data,
        headers={"Content-Type": "application/json", "User-Agent": "AutoResolver/2.0"}
    )
    try:
        t0 = time.time()
        with urllib.request.urlopen(req, timeout=120) as resp:
            res = json.loads(resp.read().decode("utf-8"))
            elapsed = round(time.time() - t0, 1)
            if res.get("success"):
                dest = res.get("destination")
                log(f"✅ [SUCCESS in {elapsed}s] {title} -> {dest}")
                return True
            else:
                err = res.get("error", "Unknown error")
                log(f"❌ [FAILED in {elapsed}s] {title}: {err}")
                return False
    except Exception as e:
        log(f"⚠️ [ERROR] {title}: {e}")
        return False

def run_worker():
    log("Starting Background Auto-Resolver Service...")
    log(f"Connected to backend API: {BASE_URL}")

    while True:
        try:
            all_links = fetch_links()
            unresolved = []

            for item in all_links:
                item_id = item.get("_id")
                if not is_resolved(item):
                    attempts = FAILED_ATTEMPTS.get(item_id, 0)
                    if attempts < MAX_RETRIES:
                        unresolved.append(item)

            if not unresolved:
                # All currently discovered links are 100% resolved!
                # Idle for 10 seconds before checking for newly scraped titles.
                time.sleep(10)
                continue

            # Sort by priority
            unresolved.sort(key=rank_item)
            total = len(unresolved)
            batch = unresolved[:5]

            log(f"Queue: {total} unresolved. Spawning parallel batch of {len(batch)} items...")

            with concurrent.futures.ThreadPoolExecutor(max_workers=5) as executor:
                futures = {
                    executor.submit(
                        resolve_item,
                        item.get("_id"),
                        item.get("filename") or item.get("title") or "Untitled Release"
                    ): item for item in batch
                }
                for fut in concurrent.futures.as_completed(futures):
                    item = futures[fut]
                    item_id = item.get("_id")
                    title = item.get("filename") or item.get("title") or "Item"
                    try:
                        success = fut.result()
                        if not success:
                            FAILED_ATTEMPTS[item_id] = FAILED_ATTEMPTS.get(item_id, 0) + 1
                            if FAILED_ATTEMPTS[item_id] >= MAX_RETRIES:
                                log(f"Skipping {title} after {MAX_RETRIES} failed attempts.")
                    except Exception as exc:
                        FAILED_ATTEMPTS[item_id] = FAILED_ATTEMPTS.get(item_id, 0) + 1

            time.sleep(2)

        except Exception as loop_err:
            log(f"Unexpected worker loop exception: {loop_err}")
            time.sleep(10)

if __name__ == "__main__":
    run_worker()
