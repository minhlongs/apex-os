const fs = require('fs');
const path = '/Users/macbook/apex-os/src/__tests__/emails/email-queue.test.ts';

const code = fs.readFileSync(path, 'utf8');
// Just a sanity check that placeholder exists
console.log('Found file of length:', code.length);
