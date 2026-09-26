import { chromium } from 'playwright';
import fs from 'fs';

async function test() {
  const browser = await chromium.launch({
    channel: 'chrome',
    headless: false,
    args: ['--disable-blink-features=AutomationControlled'],
  });
  const context = await browser.newContext();
  const page = await context.newPage();
  console.log('Navigating to xdmovies with chrome...');
  await page.goto('https://top.xdmovies.wtf/series/shaque-trust-no-one-2160p-1080p-hindi-tamil-download-285147').catch(() => {});

  await page.waitForTimeout(4000);
  const cfFrame = page.frames().find((f) => f.url().includes('challenges.cloudflare.com'));
  if (cfFrame) {
    console.log('Found CF frame:', cfFrame.url());
    const frameContent = await cfFrame.content();
    console.log('Frame HTML snippet:', frameContent.slice(0, 300));
    const checkbox = await cfFrame.$('input[type="checkbox"], .ctp-checkbox-label, #challenge-stage');
    console.log('Found checkbox element in frame:', !!checkbox);
    if (checkbox) {
      console.log('Clicking checkbox in frame...');
      await checkbox.click({ delay: 50 });
    }
  } else {
    console.log('No CF frame found. Total frames:', page.frames().length);
  }

  for (let i = 0; i < 15; i++) {
    await page.waitForTimeout(1000);
    const title = await page.title();
    console.log(`Sec ${i} Title: ${title}`);
    if (!title.includes('moment')) {
      const html = await page.content();
      console.log('SOLVED! Page length:', html.length);
      fs.writeFileSync('scratch/shaque.html', html, 'utf8');
      break;
    }
  }
  await browser.close();
}

test().catch(console.error);
