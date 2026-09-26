import { chromium } from 'playwright';

async function testMediatorFlow(mediatorUrl) {
  console.log('Testing mediator flow on:', mediatorUrl);

  const browser = await chromium.launch({
    headless: false, // Run headed so we can see the window and interact if needed
    args: ['--disable-blink-features=AutomationControlled'],
  });

  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 800 },
  });

  const page = await context.newPage();

  let destinationUrl = null;

  // Listen for navigations or requests to hubcloud
  page.on('response', (response) => {
    const url = response.url();
    if (url.includes('hubcloud.ist/drive/')) {
      console.log('[CAPTURED HUBCLOUD VIA RESPONSE]:', url);
      destinationUrl = url;
    }
  });

  try {
    console.log('1. Navigating to mediator...');
    await page.goto(mediatorUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });

    console.log('2. Waiting for #generateBtn...');
    await page.waitForSelector('#generateBtn', { timeout: 10000 });
    console.log('3. Clicking #generateBtn...');
    await page.click('#generateBtn');

    console.log('4. Waiting for Step 1 countdown to finish (waiting for #continueBtn)...');
    await page.waitForSelector('#continueBtn:not(.hidden)', { timeout: 20000 });
    console.log('5. Clicking #continueBtn...');
    await page.click('#continueBtn');

    console.log('6. Waiting for Step 2 page load...');
    await page.waitForURL(/step=2/, { timeout: 15000 });

    console.log('7. Waiting for Step 2 countdown to finish (waiting for turnstileContainer)...');
    await page.waitForSelector('#turnstileContainer:not(.hidden)', { timeout: 20000 });

    console.log('8. Turnstile widget is visible! Waiting for #goToLinkBtn to be enabled...');
    console.log('>>> IF A CAPTCHA APPEARS, SOLVE IT IN THE BROWSER WINDOW <<<');

    await page.waitForFunction(() => {
      const btn = document.getElementById('goToLinkBtn');
      return btn && !btn.disabled && !btn.classList.contains('hidden');
    }, { timeout: 60000 });

    console.log('9. #goToLinkBtn is enabled! Clicking #goToLinkBtn...');
    
    // Listen for navigation
    const [nav] = await Promise.all([
      page.waitForNavigation({ timeout: 25000 }).catch(() => null),
      page.click('#goToLinkBtn'),
    ]);

    // Check final URL
    await page.waitForTimeout(3000);
    const finalUrl = page.url();
    console.log('10. Current page URL after click:', finalUrl);

    if (finalUrl.includes('hubcloud.ist/drive/')) {
      destinationUrl = finalUrl;
    }

    console.log('\n=======================================');
    console.log('FINAL DESTINATION URL:', destinationUrl || finalUrl);
    console.log('=======================================\n');

  } catch (err) {
    console.error('Error during mediator flow:', err.message);
  } finally {
    await page.waitForTimeout(5000);
    await browser.close();
  }
}

// Test with the mediator URL we just resolved
testMediatorFlow('https://latestnewsonline.sbs/r/PFeDJslm');
