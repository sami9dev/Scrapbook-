const fs = require('fs');
const cheerio = require('cheerio');

const html = fs.readFileSync('C:/Users/sk621/scraper/.ua/tmp/mirzapur_series.html', 'utf-8');
const $ = cheerio.load(html);

const title = $('h1').text().trim() || $('title').text().trim();
console.log('Title:', title);

const links = [];
$('a').each((i, el) => {
  const href = $(el).attr('href') || '';
  const text = $(el).text().trim();
  if (href.includes('/download/') || href.includes('link.xdmovies') || href.includes('latestnewsonline')) {
    const card = $(el).closest('.download-item, .pack-card, .episode-card, div, section');
    const cardText = card.text().replace(/\s+/g, ' ').trim();
    
    // Look for exact release filename
    const m = cardText.match(/(Mirzapur[^\s]+\.(?:zip|mkv))/i);
    const filename = m ? m[1] : $(el).parent().text().replace(/\s+/g, ' ').trim();

    links.push({
      index: links.length + 1,
      href,
      text, // usually size
      filename,
      cardText: cardText.substring(0, 150)
    });
  }
});

console.log(`Found ${links.length} download links`);
fs.writeFileSync('C:/Users/sk621/scraper/.ua/tmp/mirzapur_links.json', JSON.stringify({ title, total: links.length, links }, null, 2));

links.forEach(l => {
  console.log(`[#${l.index}] ${l.text} | ${l.filename} | ${l.href}`);
});
