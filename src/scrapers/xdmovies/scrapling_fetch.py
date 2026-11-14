import sys
import json
import time
import os

# Ensure Windows finds installed browsers in %LOCALAPPDATA%\ms-playwright
if sys.platform == 'win32' and os.environ.get('PLAYWRIGHT_BROWSERS_PATH') == '0':
    del os.environ['PLAYWRIGHT_BROWSERS_PATH']

from scrapling.engines._browsers._stealth import StealthySession

BASE_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..', '..'))
DATA_DIR = os.path.join(BASE_DIR, 'data')
os.makedirs(DATA_DIR, exist_ok=True)
STATE_FILE = os.path.join(DATA_DIR, 'cf_session.json')

def fetch_page(url):
    try:
        with StealthySession(headless=True, solve_cloudflare=True) as session:
            if os.path.exists(STATE_FILE):
                try:
                    session.load_state(STATE_FILE)
                except Exception:
                    pass

            page = session.fetch(
                url,
                timeout=45000,
                wait_selector=".download-box",
                network_idle=False,
                disable_resources=True,
                blocked_domains={"werefilledwit.org", "deofleadyetca.org", "ghabovethec.info", "doubleclick.net"}
            )

            try:
                session.save_state(STATE_FILE)
            except Exception:
                pass

            raw = page.body if hasattr(page, 'body') and isinstance(page.body, (bytes, bytearray)) else (page.html_content if hasattr(page, 'html_content') else '')
            if isinstance(raw, (bytes, bytearray)):
                html = raw.decode('utf-8', errors='ignore')
            else:
                html = str(raw)

            return {
                "success": page.status in (200, 301, 302, 307) and len(html) > 0,
                "status": page.status,
                "html": html,
                "title": page.css('title::text').get() or ''
            }
    except Exception as e:
        return {"success": False, "status": 500, "error": str(e), "html": ""}

if __name__ == '__main__':
    if len(sys.argv) < 2:
        print(json.dumps({"success": False, "error": "URL argument missing"}))
        sys.exit(1)
    target = sys.argv[1]
    res = fetch_page(target)
    print(json.dumps(res))
