import { chromium } from 'playwright';

async function main() {
  const b = await chromium.launch({ headless: true });
  const p = await b.newPage();
  p.on('framenavigated', (frame) => {
    if (frame === p.mainFrame()) {
      console.log('MAIN FRAME NAVIGATED TO:', frame.url());
    }
  });

  const url = 'https://greenmotors.club/?id=Q1dxTzFnbjhrQm5kMG5lL01tQzcvdEhwZ0JtZVdjNUEvbXdPRHcyWGVHVUhQT0VCWld5OUJmTTJYVG1jeER3OWhvQWtXYnZPV2tTdlFLYkxCMThzRnc9PQ==';
  await p.goto(url, { waitUntil: 'domcontentloaded' });
  await p.waitForTimeout(10000);

  console.log('FINAL URL:', p.url());
  console.log('FINAL TITLE:', await p.title());
  await b.close();
}

main().catch(console.error);
