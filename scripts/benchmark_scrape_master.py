import sys
import time
import json
from scrapling.engines._browsers._stealth import StealthySession
from bs4 import BeautifulSoup

url = "https://huh.xdmovies.wtf/movies/master-2160p-1080p-hindi-tamil-download-626392"
print(f"[Benchmark] Target: {url}")
start_time = time.time()

try:
    with StealthySession(headless=True, solve_cloudflare=True) as session:
        t0 = time.time()
        print("[Benchmark] Fetching landing page with stealth browser (solving Turnstile)...")
        res = session.fetch(url, timeout=60000)
        t_landing = time.time() - t0
        print(f"[Benchmark] Landing page fetched in {t_landing:.2f}s (Status: {res.status})")

        soup = BeautifulSoup(res.text, "html.parser")
        title_el = soup.find("h1") or soup.find("title")
        page_title = title_el.get_text(strip=True) if title_el else "Unknown Title"
        print(f"[Benchmark] Title: {page_title}")

        # Extract download buttons / links
        links = []
        for a in soup.find_all("a", href=True):
            href = a["href"]
            txt = a.get_text(strip=True)
            if "/download/" in href or "link.xdmovies" in href or "latestnewsonline" in href:
                parent_text = a.find_parent().get_text(strip=True) if a.find_parent() else ""
                links.append({"url": href, "text": txt, "context": parent_text[:120]})

        print(f"[Benchmark] Found {len(links)} download links:")
        for idx, l in enumerate(links):
            print(f"  #{idx+1}: {l['text']} | context: {l['context']}")

        # Save to json for next phase
        with open("C:/Users/sk621/scraper/.ua/tmp/master_links.json", "w", encoding="utf-8") as f:
            json.dump({"title": page_title, "landing_time_sec": t_landing, "links": links}, f, indent=2)

except Exception as e:
    print(f"[Benchmark] Error fetching landing page: {e}", file=sys.stderr)
    sys.exit(1)
