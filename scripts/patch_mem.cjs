const fs = require("fs");
const p = "C:/Users/sk621/scraper/src/scrapers/xdmovies/mediator.js";
let c = fs.readFileSync(p, "utf8");

const oldStr = `      const launchArgs = [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--disable-blink-features=AutomationControlled',
        '--enable-blink-features=FakeShadowRoot',
      ];`;

const newStr = `      const launchArgs = [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--disable-blink-features=AutomationControlled',
        '--enable-blink-features=FakeShadowRoot',
        '--renderer-process-limit=1',
        '--js-flags=--max-old-space-size=128',
        '--disable-extensions',
        '--disable-background-networking',
        '--disable-default-apps',
        '--disable-sync',
        '--mute-audio',
        '--no-zygote',
      ];`;

c = c.replace(/\r\n/g, "\n");
const normalizedOld = oldStr.replace(/\r\n/g, "\n");
if (c.includes(normalizedOld)) {
  c = c.replace(normalizedOld, newStr.replace(/\r\n/g, "\n"));
  fs.writeFileSync(p, c, "utf8");
  console.log("SUCCESS: mediator.js patched");
} else {
  console.log("FAIL: oldStr not found");
}
