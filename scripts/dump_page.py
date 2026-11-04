import sys
import time
from scrapling.engines._browsers._stealth import StealthySession

url = "https://huh.xdmovies.wtf/movies/master-2160p-1080p-hindi-tamil-download-626392"
with StealthySession(headless=True, solve_cloudflare=True) as session:
    res = session.fetch(url, timeout=60000)
    with open("C:/Users/sk621/scraper/.ua/tmp/master_page.html", "w", encoding="utf-8") as f:
        f.write(res.text)
    print(f"Saved {len(res.text)} bytes to master_page.html")
