
import puppeteer from 'puppeteer';
(async () => {
  const browser = await puppeteer.launch({ headless: 'new' });
  const page = await browser.newPage();
  await page.goto('http://localhost:3001');
  await page.waitForFunction(() => document.body.innerText.includes('노듈러 거더'), { timeout: 10000 });
  await page.waitForTimeout(1000);
  const elements = await page.evaluate(() => {
    return Array.from(document.querySelectorAll('text')).map(el => ({
      text: el.textContent,
      html: el.outerHTML,
      parent: el.parentElement.outerHTML
    }));
  });
  const found = elements.filter(e => e.text.includes('영상'));
  console.log(JSON.stringify(found, null, 2));
  await browser.close();
})();

