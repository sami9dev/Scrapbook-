import sys
import time
import json
import urllib.request
import urllib.parse
from scrapling_resolver import resolve_mediator

with open("C:/Users/sk621/scraper/.ua/tmp/master_extracted.json", "r", encoding="utf-8") as f:
    data = json.load(f)

links = data["links"]
print(f"[Benchmark] Starting resolution of {len(links)} Master (2021) releases...")

benchmark_results = []

for idx, item in enumerate(links):
    med_url = item["url"]
    context = item["context"]
    size_str = item["text"]
    
    # Extract clean filename from context
    filename = context.replace(size_str, "").strip() if size_str in context else context
    print(f"\n[{idx+1}/{len(links)}] Resolving: {filename} ({size_str})")
    
    t0 = time.time()
    res = resolve_mediator(med_url)
    elapsed = time.time() - t0
    
    hubcloud_dest = res.get("destination")
    success = res.get("success", False)
    error = res.get("error")
    
    print(f"  Result: Success={success}, Time={elapsed:.2f}s")
    if hubcloud_dest:
        print(f"  Direct HubCloud: {hubcloud_dest}")
    else:
        print(f"  Error: {error}")
        
    benchmark_results.append({
        "index": idx + 1,
        "filename": filename,
        "size": size_str,
        "mediatorUrl": med_url,
        "hubcloudUrl": hubcloud_dest,
        "success": success,
        "elapsed_sec": round(elapsed, 2),
        "error": error
    })
    
    # Save progressive results
    with open("C:/Users/sk621/scraper/.ua/tmp/master_resolved_benchmark.json", "w", encoding="utf-8") as f:
        json.dump(benchmark_results, f, indent=2)

print("\n[Benchmark] All releases processed!")
