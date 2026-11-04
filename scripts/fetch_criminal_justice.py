import sys, time, json
from scrapling.engines._browsers._stealth import StealthySession
from bs4 import BeautifulSoup

url = 'https://huh.xdmovies.wtf/series/criminal-justice-1080p-720p-hindi-download-88177'
print(f'Fetching landing page: {url}')

with StealthySession(headless=True, solve_cloudflare=True) as session:
    res = session.fetch(url, timeout=60000)
    print(f'Status: {res.status}, Length: {len(res.text)}')
    soup = BeautifulSoup(res.text, 'html.parser')
    h1 = soup.find('h1') or soup.find('title')
    title = h1.get_text(strip=True) if h1 else 'Unknown'
    print(f'Title: {title}')

    with open('C:/Users/sk621/scraper/.ua/tmp/criminal_justice.html', 'w', encoding='utf-8') as f:
        f.write(res.text)

    links = []
    for a in soup.find_all('a', href=True):
        href = a['href']
        text = a.get_text(strip=True)
        if any(k in href for k in ['/download/', 'link.xdmovies', 'latestnewsonline']):
            p_text = a.find_parent().get_text(strip=True) if a.find_parent() else ''
            links.append({'url': href, 'text': text, 'context': p_text[:140]})

    print(f'Found {len(links)} download links:')
    for i, l in enumerate(links[:20]):
        txt = l['text']
        u = l['url']
        ctx = l['context'][:80]
        print(f" #{i+1}: text='{txt}' | url={u} | context={ctx}")

    with open('C:/Users/sk621/scraper/.ua/tmp/criminal_justice_links.json', 'w', encoding='utf-8') as f:
        json.dump({'title': title, 'total': len(links), 'links': links}, f, indent=2)
