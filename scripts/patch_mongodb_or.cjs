const fs = require('fs');
const file = 'C:/Users/sk621/scraper/src/database/mongodb.js';
let content = fs.readFileSync(file, 'utf8');

const target = '  find(query = {}) {\r\n    let docs = this.documents.filter((doc) => {\r\n      return Object.entries(query).every(([k, v]) => {';
const replacement = `  find(query = {}) {
    let docs = this.documents.filter((doc) => {
      return Object.entries(query).every(([k, v]) => {
        if (k === '$or' && Array.isArray(v)) {
          return v.some((subQuery) => {
            return Object.entries(subQuery).every(([sk, sv]) => {
              if (sv instanceof RegExp) return sv.test(doc[sk] || '');
              if (sv && typeof sv === 'object' && sv.$regex) {
                const re = sv.$regex instanceof RegExp ? sv.$regex : new RegExp(sv.$regex, sv.$options || 'i');
                return re.test(doc[sk] || '');
              }
              return doc[sk] === sv;
            });
          });
        }`;

if (content.includes(target)) {
  content = content.replace(target, replacement.replace(/\n/g, '\r\n'));
  fs.writeFileSync(file, content, 'utf8');
  console.log('Successfully patched $or in InMemoryCollection.find');
} else {
  console.error('Target not found in mongodb.js');
}
