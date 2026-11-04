const fs = require('fs');
const cheerio = require('cheerio');

const html = fs.readFileSync('C:/Users/sk621/scraper/.ua/tmp/special_ops.html', 'utf-8');
console.log('HTML length:', html.length);

const $ = cheerio.load(html);
const title = $('h1').text().trim() || $('title').text().trim();
console.log('Title:', title);

const links = [];
$('a').each((i, el) => {
  const href = $(el).attr('href') || '';
  const text = $(el).text().trim();
  if (href.includes('/download/') || href.includes('link.xdmovies') || href.includes('latestnewsonline')) {
    // Get context from parent, grandparent, or preceding heading
    const parent = $(el).parent();
    const grandParent = parent.parent();
    const heading = $(el).closest('.download-item, .pack-card, .episode-card').find('h2, h3, h4, .title, .file-name').text().trim()
      || $(el).prevAll('h2, h3, h4, strong, p').first().text().trim()
      || parent.text().trim();

    links.push({
      index: links.length + 1,
      href,
      text,
      context: heading.replace(/\s+/g, ' ').trim(),
      cardText: $(el).closest('div, section, p').text().replace(/\s+/g, ' ').trim().substring(0, 150)
    });
  }
});

console.log(`Found ${links.length} download links`);
fs.writeFileSync('C:/Users/sk621/scraper/.ua/tmp/special_ops_links.json', JSON.stringify({ title, total: links.length, links }, null, 2));

links.forEach(l => {
  console.log(`[#${l.index}] text="${l.text}" | href="${l.href}" | context="${l.context.substring(0, 80)}"`);
});
