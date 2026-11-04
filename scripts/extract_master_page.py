import sys
import time
import json
from scrapling.engines._browsers._stealth import StealthySession
from bs4 import BeautifulSoup

url = "https://huh.xdmovies.wtf/movies/master-2160p-1080p-hindi-tamil-download-626392"
print(f"[Benchmark] Extracting Master page via page_action: {url}")

extracted_data = {}

def page_action(page):
    time.sleep(3) # Wait for DOM after Turnstile
    content = page.content()
    soup = BeautifulSoup(content, "html.parser")
    title_el = soup.find("h1") or soup.find("title")
    title = title_el.get_text(strip=True) if title_el else "Unknown Title"
    
    links = []
    for a in soup.find_all("a", href=True):
        href = a["href"]
        txt = a.get_text(strip=True)
        if "/download/" in href or "link.xdmovies" in href or "latestnewsonline" in href:
            parent_text = a.find_parent().get_text(strip=True) if a.find_parent() else ""
            links.append({"url": href, "text": txt, "context": parent_text[:120]})
            
    extracted_data["title"] = title
    extracted_data["html_length"] = len(content)
    extracted_data["links"] = links
    print(f"[PageAction] Title: {title}, Content length: {len(content)}, Found {len(links)} links")

t0 = time.time()
with StealthySession(headless=True, solve_cloudflare=True) as session:
    session.fetch(url, page_action=page_action, timeout=60000)
t_elapsed = time.time() - t0

extracted_data["elapsed_sec"] = t_elapsed
with open("C:/Users/sk621/scraper/.ua/tmp/master_extracted.json", "w", encoding="utf-8") as f:
    json.dump(extracted_data, f, indent=2)

print(f"[Benchmark] Finished in {t_elapsed:.2f}s. Extracted {len(extracted_data.get('links', []))} download links.")
