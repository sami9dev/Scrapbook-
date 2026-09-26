import { chromium } from 'playwright';
import fs from 'fs';

async function inspectMediator() {
  const browser = await chromium.launch({
    headless: false,
    args: ['--disable-blink-features=AutomationControlled'],
  });

  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 800 },
    extraHTTPHeaders: {
      'Referer': 'https://link.xdmovies.wtf/'
    }
  });

  const page = await context.newPage();

  try {
    console.log('Navigating to mediator...');
    await page.goto('https://latestnewsonline.sbs/r/PFeDJslm', { waitUntil: 'load', timeout: 30000 });
    console.log('Page Title:', await page.title());
    console.log('Current URL:', page.url());

    const html = await page.content();
    fs.writeFileSync('scratch/mediator_dump.html', html, 'utf8');
    console.log('Dumped HTML to scratch/mediator_dump.html, length:', html.length);

    const hasGenerate = await page.$('#generateBtn');
    console.log('Has #generateBtn element:', Boolean(hasGenerate));

    if (hasGenerate) {
      const isVisible = await hasGenerate.isVisible();
      console.log('Is #generateBtn visible:', isVisible);
    }

    const hasTurnstile = await page.$('.cf-turnstile');
    console.log('Has .cf-turnstile element:', Boolean(hasTurnstile));

    await page.waitForTimeout(5000);
  } catch (e) {
    console.error('Error:', e.message);
  } finally {
    await browser.close();
  }
}

inspectMediator();
