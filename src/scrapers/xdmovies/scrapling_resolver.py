import sys
import time
import json
import os
import tempfile
import shutil
from scrapling.engines._browsers._stealth import StealthySession

def resolve_mediator(url):
    started_at = time.time()
    result = {"success": False, "destination": None, "error": None, "elapsedMs": 0}
    captured_dest = []

    def page_automation(page):
        ctx = page.context

        # Helper to check if a URL is hubcloud drive
        def check_url(u):
            if u and ("hubcloud.ist/drive/" in u or "hubcloud." in u and "/drive/" in u):
                # Normalize to canonical hubcloud.ist
                from urllib.parse import urlparse
                p = urlparse(u)
                if p.path.startswith("/drive/"):
                    canonical = f"https://hubcloud.ist{p.path}"
                    if p.query:
                        canonical += f"?{p.query}"
                    if canonical not in captured_dest:
                        captured_dest.append(canonical)

        # Track network requests
        def on_request(req):
            check_url(req.url)

        # Track new pages (popups / new tabs)
        def on_page(new_page):
            new_page.on("request", on_request)
            check_url(new_page.url)

        ctx.on("page", on_page)
        page.on("request", on_request)

        # Check current URL
        check_url(page.url)
        if captured_dest:
            return

        # 1. Click #generateBtn
        try:
            page.wait_for_selector("#generateBtn:not(.hidden)", timeout=20000)
            time.sleep(1)
            page.evaluate("() => { const b = document.getElementById('generateBtn'); if (b) b.click(); }")
        except Exception as e:
            # Maybe already bypassed or directly on step 2
            pass

        if captured_dest:
            return

        # 2. Wait for #continueBtn
        try:
            page.wait_for_selector("#continueBtn:not(.hidden)", timeout=25000)
            time.sleep(1)
            page.evaluate("() => { const b = document.getElementById('continueBtn'); if (b) b.click(); }")
        except Exception as e:
            pass

        if captured_dest:
            return

        # 3. Wait for step=2
        try:
            page.wait_for_url(lambda u: "step=2" in str(u), timeout=20000)
        except Exception:
            pass

        # 4. Wait for turnstile container & buffer socket heartbeats
        try:
            page.wait_for_selector("#turnstileContainer:not(.hidden)", timeout=20000)
        except Exception:
            pass

        time.sleep(8)

        # 5. Wait for #goToLinkBtn to be enabled
        button_clicked = False
        for _ in range(25):
            for p in ctx.pages:
                check_url(p.url)
            if captured_dest:
                break

            is_ready = False
            try:
                is_ready = page.evaluate("""() => {
                    const inp = document.querySelector('[name="cf-turnstile-response"]');
                    if (inp && inp.value && typeof window.onTurnstileSuccess === 'function') {
                        window.onTurnstileSuccess(inp.value);
                    }
                    const btn = document.getElementById('goToLinkBtn');
                    return btn && !btn.disabled && !btn.classList.contains('hidden');
                }""")
            except Exception:
                pass

            if is_ready:
                button_clicked = True
                try:
                    page.evaluate("""() => {
                        const inp = document.querySelector('[name="cf-turnstile-response"]');
                        if (inp && inp.value && typeof window.onTurnstileSuccess === 'function') {
                            window.onTurnstileSuccess(inp.value);
                        }
                        const btn = document.getElementById('goToLinkBtn');
                        if (btn) btn.click();
                    }""")
                except Exception:
                    pass
                time.sleep(3)
                break

            # If Turnstile iframe is present, click it
            frames = [f for f in page.frames if "challenges.cloudflare" in f.url or "turnstile" in f.url]
            for f in frames:
                try:
                    el = f.frame_element()
                    box = el.bounding_box()
                    if box and box["width"] > 50 and box["height"] > 30:
                        cx = box["x"] + 28
                        cy = box["y"] + box["height"] / 2
                        page.mouse.click(cx, cy)
                except Exception:
                    pass
            time.sleep(1.5)

        # 6. Wait for destination URL to appear in any tab or network
        for _ in range(15):
            for p in ctx.pages:
                check_url(p.url)
            if captured_dest:
                break
            time.sleep(1)

    profile_dir = tempfile.mkdtemp(prefix=f"scrapling_p_{os.getpid()}_{int(time.time()*1000)}_")
    try:
        with StealthySession(headless=True, solve_cloudflare=True, user_data_dir=profile_dir) as session:
            session.fetch(url, page_action=page_automation, timeout=75000)
    except Exception as err:
        result["error"] = str(err)
    finally:
        try:
            shutil.rmtree(profile_dir, ignore_errors=True)
        except Exception:
            pass

    if captured_dest:
        result["success"] = True
        result["destination"] = captured_dest[0]
        result["error"] = None
    elif not result["error"]:
        result["error"] = "Destination not reached within timeout"

    result["elapsedMs"] = int((time.time() - started_at) * 1000)
    return result

if __name__ == "__main__":
    if len(sys.argv) < 2:
        print(json.dumps({"success": False, "error": "No URL provided"}))
        sys.exit(1)

    target_url = sys.argv[1].strip()
    res = resolve_mediator(target_url)
    print(json.dumps(res))
