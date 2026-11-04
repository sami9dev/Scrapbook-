import json
with open("C:/Users/sk621/scraper/.ua/tmp/criminal_justice_parsed.json", "r", encoding="utf-8") as f:
    data = json.load(f)

for i in range(35, 45):
    l = data["links"][i]
    print(f"#{i+1}: text='{l['text']}' | heading='{l['heading']}' | url='{l['url']}'")
