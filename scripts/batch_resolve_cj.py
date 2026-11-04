import sys, time, json
import urllib.request
sys.path.append("C:/Users/sk621/scraper/src/scrapers/xdmovies")
from scrapling_resolver import resolve_mediator

TARGETS = [
    {
        "season": "Season 1",
        "res": "1080p",
        "size": "12.73 GB",
        "title": "Criminal Justice S01 (2019) 1080p WEB-DL AAC2.0 H.264 Zip",
        "mediator": "https://link.xdmovies.wtf/download/5f1c7GV3c7rsFJ4vbeGMiPqVSw8hnpJdf8gb-20LzSk",
        "hubcloud": "https://hubcloud.ist/drive/yifqqgut1mdfxtq" # Already solved
    },
    {
        "season": "Season 1",
        "res": "720p",
        "size": "3.43 GB",
        "title": "Criminal Justice S01 (2019) 720p WEB-DL AAC2.0 H.264 Zip",
        "mediator": "https://link.xdmovies.wtf/download/dWc_vjyHv8wY5HJ7oGf_l1aTTBoXy-rkEg5WNjly2ls",
        "hubcloud": None
    },
    {
        "season": "Season 2",
        "res": "1080p",
        "size": "10.32 GB",
        "title": "Criminal Justice S02: Behind Closed Doors (2020) 1080p WEB-DL AAC2.0 H.264 Zip",
        "mediator": "https://link.xdmovies.wtf/download/FBfTV6k8RGecj1r5m8dyvTfAu312C1Gn5EDM6SVvOdg",
        "hubcloud": None
    },
    {
        "season": "Season 2",
        "res": "720p",
        "size": "3.44 GB",
        "title": "Criminal Justice S02: Behind Closed Doors (2020) 720p WEB-DL AAC2.0 H.264 Zip",
        "mediator": "https://link.xdmovies.wtf/download/nCfJ29Flleq_mRdVwn0A2mKIV8zD7R4iYQoF3K7o3YY",
        "hubcloud": None
    },
    {
        "season": "Season 3",
        "res": "1080p",
        "size": "12.55 GB",
        "title": "Criminal Justice S03: Adhura Sach (2022) 1080p WEB-DL AAC2.0 H.264 Zip",
        "mediator": "https://link.xdmovies.wtf/download/GgQcGV78zxQh4Z8cfs7eDno-DNgTHiKBOQVTx4yT3S8",
        "hubcloud": None
    },
    {
        "season": "Season 3",
        "res": "720p",
        "size": "4.06 GB",
        "title": "Criminal Justice S03: Adhura Sach (2022) 720p WEB-DL AAC2.0 H.264 Zip",
        "mediator": "https://link.xdmovies.wtf/download/lFWTNs9bJfWNMV2QIiL7P5vWxSeQcpz5sKEq-3a2GnA",
        "hubcloud": None
    },
    {
        "season": "Season 4",
        "res": "1080p",
        "size": "9.51 GB",
        "title": "Criminal Justice S04 (2024) 1080p WEB-DL AAC2.0 H.264 Zip",
        "mediator": "https://link.xdmovies.wtf/download/7j6PJG1Z7jU3m0-27WmRuFJ8wFDJ8PBnwcQjq7JNuR0",
        "hubcloud": None
    },
    {
        "season": "Season 4",
        "res": "720p",
        "size": "3.67 GB",
        "title": "Criminal Justice S04 (2024) 720p WEB-DL AAC2.0 H.264 Zip",
        "mediator": "https://link.xdmovies.wtf/download/z_Bbw_IoAWqMgnFad11MBKKMIieQO7pUE9AAQbnOkrs",
        "hubcloud": None
    }
]

out_file = "C:/Users/sk621/scraper/.ua/tmp/criminal_justice_resolved.json"

for idx, item in enumerate(TARGETS):
    if item["hubcloud"]:
        print(f"[{idx+1}/{len(TARGETS)}] {item['title']} already resolved: {item['hubcloud']}")
        continue

    print(f"\n[{idx+1}/{len(TARGETS)}] Resolving {item['title']} ({item['size']})...")
    t0 = time.time()
    res = resolve_mediator(item["mediator"])
    elapsed = time.time() - t0

    if res.get("success") and res.get("destination"):
        item["hubcloud"] = res["destination"]
        print(f"  -> SUCCESS ({elapsed:.1f}s): {res['destination']}")
    else:
        print(f"  -> FAILED ({elapsed:.1f}s): {res.get('error')}")

    with open(out_file, "w", encoding="utf-8") as f:
        json.dump(TARGETS, f, indent=2)

print("\nAll done! Output written to", out_file)
