import json

with open("C:/Users/sk621/scraper/.ua/tmp/criminal_justice_parsed.json", "r", encoding="utf-8") as f:
    data = json.load(f)

print(f"Total links: {len(data['links'])}")
for idx, l in enumerate(data["links"]):
    # Look for Season Zip packs
    size_str = l["text"].split()[0]
    try:
        size_val = float(size_str)
    except:
        size_val = 0.0
    if size_val >= 2.0 or "zip" in l["heading"].lower():
        print(f"Index {idx+1}: {l['heading']} | size={l['text']} | url={l['url']}")
