import urllib.request, json
data = json.loads(urllib.request.urlopen('https://scrapbook-0mrx.onrender.com/api/links?limit=500').read().decode())
cj = [x for x in data if "criminal" in x.get("title", "").lower()]
print(f"Total returned: {len(data)}, Criminal Justice count: {len(cj)}")
for i in cj[:6]:
    print(i.get('title'), '|', i.get('sizeDisplay'), '->', i.get('providerUrl'))
