import sys
import time
import urllib.parse
from scrapling.engines._browsers._stealth import StealthySession
from bs4 import BeautifulSoup

titles = [
    "Sacred Games",
    "Ghoul",
    "Selection Day",
    "Delhi Crime",
    "Bard of Blood",
    "Mighty Little Bheem",
    "Jamtara"
]

print("Starting XDMovies search for missing titles...")

found_urls = {}

def search_title(title):
    query = urllib.parse.quote_plus(title)
    url = f"https://huh.xdmovies.wtf/?s={query}"
    print(f"\nSearching: {title} -> {url}")
    try:
        with StealthySession(headless=True, solve_cloudflare=True) as session:
            res = session.fetch(url, timeout=45000)
            soup = BeautifulSoup(res.text, "html.parser")
            
            # Find movie/series post links
            links = []
            for a in soup.find_all("a", href=True):
                href = a["href"]
                if ("/movies/" in href or "/series/" in href) and "huh.xdmovies.wtf" in href:
                    txt = a.get_text(strip=True) or a.get("title", "")
                    if href not in [x[0] for x in links]:
                        links.append((href, txt))
            print(f"Found {len(links)} links for {title}:")
            for href, txt in links[:5]:
                print(f"  - {txt}: {href}")
            if links:
                found_urls[title] = links[0][0]
    except Exception as e:
        print(f"Error searching {title}: {e}")

for t in titles:
    search_title(t)
    time.sleep(2)

print("\n=== SUMMARY OF FOUND URLS ===")
for t, u in found_urls.items():
    print(f'"{t}": "{u}",')
