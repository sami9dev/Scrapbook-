import sys
import time
import json
import urllib.request
import urllib.parse
from scrapling.engines._browsers._stealth import StealthySession
from bs4 import BeautifulSoup
from scrapling_resolver import resolve_mediator

url = "https://huh.xdmovies.wtf/movies/players-1080p-720p-hindi-download-83382"
print(f"[Players] Starting extraction: {url}")

extracted = {}

def page_action(page):
    time.sleep(3)
    content = page.content()
    soup = BeautifulSoup(content, "html.parser")
    title_el = soup.find("h1") or soup.find("title")
    title = title_el.get_text(strip=True) if title_el else "Players (2012)"
    
    links = []
    for a in soup.find_all("a", href=True):
        href = a["href"]
        txt = a.get_text(strip=True)
        if "/download/" in href or "link.xdmovies" in href or "latestnewsonline" in href:
            parent_text = a.find_parent().get_text(strip=True) if a.find_parent() else ""
            links.append({"url": href, "text": txt, "context": parent_text[:140]})
            
    extracted["title"] = title
    extracted["links"] = links
    print(f"[Players] Found title: {title}, {len(links)} links")

t0 = time.time()
with StealthySession(headless=True, solve_cloudflare=True) as session:
    session.fetch(url, page_action=page_action, timeout=65000)
t_landing = time.time() - t0
print(f"[Players] Landing page extracted in {t_landing:.2f}s")

links = extracted.get("links", [])
resolved_releases = []

print(f"[Players] Resolving {len(links)} releases to Direct HubCloud...")

for idx, item in enumerate(links):
    med_url = item["url"]
    context = item["context"]
    size_str = item["text"]
    filename = context.replace(size_str, "").strip() if size_str in context else context
    
    print(f"\n[{idx+1}/{len(links)}] Resolving: {filename} ({size_str})")
    tr0 = time.time()
    res = resolve_mediator(med_url)
    tr_elapsed = time.time() - tr0
    
    hubcloud = res.get("destination")
    success = res.get("success", False)
    error = res.get("error")
    
    print(f"  Result: Success={success}, Time={tr_elapsed:.2f}s")
    if hubcloud:
        print(f"  Direct HubCloud: {hubcloud}")
    else:
        print(f"  Error: {error}")
        
    resolved_releases.append({
        "index": idx + 1,
        "filename": filename,
        "size": size_str,
        "mediatorUrl": med_url,
        "hubcloudUrl": hubcloud,
        "success": success,
        "elapsed_sec": round(tr_elapsed, 2),
        "error": error
    })

with open("C:/Users/sk621/scraper/.ua/tmp/players_resolved.json", "w", encoding="utf-8") as f:
    json.dump({"title": extracted.get("title", "Players (2012)"), "releases": resolved_releases}, f, indent=2)

print("\n[Players] Complete! Data saved.")
