from scrapling.engines._browsers._stealth import StealthySession
with StealthySession(headless=True, solve_cloudflare=True) as session:
    res = session.fetch("https://huh.xdmovies.wtf/series/criminal-justice-1080p-720p-hindi-download-88177", timeout=60000)
    print("type(res):", type(res))
    print("status:", getattr(res, "status", None))
    print("text len:", len(getattr(res, "text", "")))
    print("body len:", len(getattr(res, "body", b"")))
    if hasattr(session, "page"):
        print("session.page url:", session.page.url)
        content = session.page.content()
        print("page content len:", len(content))
        with open("C:/Users/sk621/scraper/.ua/tmp/criminal_justice_page.html", "w", encoding="utf-8") as f:
            f.write(content)
