const fs = require('fs');
const s = fs.readFileSync('/Users/macbook/apex-os/src/i18n/messages/vi.json', 'utf8');
let stack = [];
let opens = 0, closes = 0;
const lines = s.split('\n');
for (let i = 0; i < lines.length; i++) {
  const line = lines[i];
  for (let j = 0; j < line.length; j++) {
    const ch = line[j];
    if (ch === '{') {
      opens++;
      stack.push({ line: i + 1, col: j + 1 });
    } else if (ch === '}') {
      closes++;
      if (stack.length === 0) {
        console.log('Unmatched } at line', i + 1, 'col', j + 1);
      } else {
        stack.pop();
      }
    }
  }
}
console.log('Total opens:', opens, 'closes:', closes);
console.log('Stack size at end:', stack.length);
if (stack.length > 0) {
  console.log('Unclosed { at lines:', stack.map(x => x.line));
} else {
  console.log('All balanced');
}
