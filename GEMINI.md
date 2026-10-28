# CineFuel Project Guidelines & Learned Preferences

## Core Resolution Rules

### 1. Always Return V-Cloud Over Other Mirrors
When scraping, parsing, or resolving intermediate mediator pages (such as **Nexdrive**, **Vegamovies**, **Rogmovies**, etc.) where **V-Cloud** links (`vcloud.*`) and alternative mirrors (e.g. **Filebee**, **G-Drive**, **Filepress**) coexist:
- **Always prioritize and return V-Cloud links.**
- Do not drop, omit, or replace V-Cloud links with Filebee or generic G-Drive mirrors.
- If an episode or pack provides both a V-Cloud link and an alternative mirror, select and return the V-Cloud link for that item.

### 2. Accurate Episode Header Parsing
- For series pages structured with section headers (such as `<h4>-:Episodes: X:-</h4>` or `Episode X`), correctly attribute each download link to its specific episode number.
- Never collapse or default all links to a single episode (e.g., `S01E02`).

### 3. Exclude WordPress Taxonomy & Category Links
- Filter out taxonomy URLs (e.g. `/category/`, `/uncategorized/`, `genxfm...category`) from candidate download sets.

### 4. Multi-Quality Scraping: Extract and Return ALL Available Qualities
- When a release post contains multiple quality tiers (such as 480p, 720p, 1080p, 2160p 4K, along with Batch/Zip packs), scrape, extract, and return **ALL available qualities** by default.
- Never collapse or discard distinct quality tiers. Ensure section headers (e.g. `<h5>... 480p x264 [150MB/E]</h5>`) propagate their `quality`, `codec`, and `sizeDisplay` to the corresponding download buttons.
- For each quality tier, adhere to Rule 1 by prioritizing **V-Cloud** over alternative mirrors (e.g. G-Direct) while keeping **Batch/Zip** packs tagged with `scope: 'pack'`.

### 5. Always Return Canonical Nexdrive URLs (`https://nexdrive.beer/genxfm`)
- Whenever Nexdrive intermediate links with the `/genxfm` path prefix are discovered, extracted, or returned (such as `nexdrive.fit`, `nexdrive.top`, `nexdrive.lat`, `nexdrive.xyz`, etc.):
- **Always normalize and return `https://nexdrive.beer/genxfm...`** as the canonical destination URL.
- Never return obsolete mirror domains (like `.fit`) that redirect; ensure all candidate links, database records, and API responses provide `https://nexdrive.beer/genxfm...`.


