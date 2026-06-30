const fs = require('fs');

function mergeMessages(en, vi) {
  if (typeof en === 'object' && en !== null) {
    if (typeof vi === 'object' && vi !== null) {
      // Both objects - merge recursively
      const result = { ...en };
      for (const key in vi) {
        if (vi.hasOwnProperty(key)) {
          if (typeof vi[key] === 'string' && vi[key] !== en[key]) {
            // Use Vietnamese translation if it's a string and different from English
            result[key] = vi[key];
          } else if (typeof vi[key] === 'object' && typeof en[key] === 'object') {
            // Recurse into nested objects
            result[key] = mergeMessages(en[key] || {}, vi[key]);
          }
        }
      }
      return result;
    }
    return en;
  }
  return en;
}

try {
  const en = JSON.parse(fs.readFileSync('/Users/macbook/apex-os/src/i18n/messages/en.json', 'utf8'));
  const vi = JSON.parse(fs.readFileSync('/Users/macbook/apex-os/src/i18n/messages/vi.json', 'utf8'));

  const merged = mergeMessages(en, vi);

  fs.writeFileSync('/Users/macbook/apex-os/src/i18n/messages/vi.json', JSON.stringify(merged, null, 2) + '\n');
  console.log('vi.json merged successfully');
} catch (e) {
  console.error('Error:', e.message);
  // Fallback: just copy en.json
  try {
    const en = JSON.parse(fs.readFileSync('/Users/macbook/apex-os/src/i18n/messages/en.json', 'utf8'));
    fs.writeFileSync('/Users/macbook/apex-os/src/i18n/messages/vi.json', JSON.stringify(en, null, 2) + '\n');
    console.log('vi.json replaced with en.json as fallback');
  } catch (e2) {
    console.error('Fallback failed:', e2.message);
  }
}
