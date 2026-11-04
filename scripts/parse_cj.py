import json
from scrapling.engines._browsers._stealth import StealthySession
from bs4 import BeautifulSoup

url = "https://huh.xdmovies.wtf/series/criminal-justice-1080p-720p-hindi-download-88177"
with StealthySession(headless=True, solve_cloudflare=True) as session:
    res = session.fetch(url, timeout=60000)
    html = res.body.decode("utf-8", errors="ignore")
    soup = BeautifulSoup(html, "html.parser")
    
    title_el = soup.find("h1") or soup.find("title")
    title = title_el.get_text(strip=True) if title_el else "Unknown Title"
    print(f"Title: {title}")
    
    links = []
    for a in soup.find_all("a", href=True):
        href = a["href"]
        text = a.get_text(strip=True)
        if any(k in href for k in ["/download/", "link.xdmovies", "latestnewsonline"]):
            p = a.find_parent()
            p_text = p.get_text(strip=True) if p else ""
            # Look a bit higher up for headings or season info
            prev_heading = ""
            for prev in a.find_all_previous(["h2", "h3", "h4", "p", "strong"]):
                txt = prev.get_text(strip=True)
                if any(kw in txt.lower() for kw in ["season", "720p", "1080p", "480p", "episode", "batch", "zip"]):
                    prev_heading = txt
                    break
            links.append({
                "url": href,
                "text": text,
                "context": p_text,
                "heading": prev_heading
            })

    print(f"Total links found: {len(links)}")
    for i, l in enumerate(links):
        print(f"#{i+1}: text='{l['text']}' | heading='{l['heading']}' | url='{l['url']}'")

    with open("C:/Users/sk621/scraper/.ua/tmp/criminal_justice_parsed.json", "w", encoding="utf-8") as f:
        json.dump({"title": title, "url": url, "links": links}, f, indent=2)
