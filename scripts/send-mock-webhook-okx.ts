/**
 * Mock OKX Webhook Sender - Testing Utility
 * Sends mock trade notifications to the OKX webhook endpoint for testing
 *
 * USAGE:
 *   npx tsx scripts/send-mock-webhook-okx.ts --volume 1000 --symbol BTC-USDT
 *   npx tsx scripts/send-mock-webhook-okx.ts --volume 500 --symbol ETH-USDT
 *   npx tsx scripts/send-mock-webhook-okx.ts --duplicate --delay 2000  # Test replay protection
 *
 * FLAGS:
 *   --volume      Trade volume in USD (default: 1000)
 *   --symbol      Trading pair (default: BTC-USDT)
 *   --secret      Webhook secret (uses env var if omitted)
 *   --endpoint    Webhook URL (default: http://localhost:3000/api/webhooks/exchange/okx)
 *   --api-key     OKX API key (simulates header OK-ACCESS-KEY)
 *   --timestamp   Timestamp in milliseconds (defaults to current time)
 *   --duplicate   Send same webhook twice to test replay protection
 *   --delay       Delay between duplicate sends in ms (default: 1000)
 *
 * ENV VARS:
 *   OKX_WEBHOOK_SECRET  Secret for OKX webhook verification
 *
 * REPLAY PROTECTION TEST:
 *   The --duplicate flag sends the identical webhook payload twice.
 *   Expected behavior:
 *     - First: 200 OK with conversion created
 *     - Second: 200 OK with {skipped: true, reason: "Duplicate webhook - replay detected"}
 *
 * SIGNATURE GENERATION:
 *   OKX signature = HMAC-SHA256(secret, timestamp + "POST" + "/api/webhooks/exchange/okx" + body)
 *   The signature is hex-encoded.
 *
 * Exportable functions for testing:
 *   - generateOkxPayload(volume, symbol)
 *   - createOkxSignature(payload, timestamp, secret)
 */

import crypto from 'node:crypto';
import https from 'node:https';

export interface Args {
  volume: number;
  symbol: string;
  secret?: string;
  endpoint: string;
  apiKey: string;
  timestamp?: number;
  duplicate?: boolean;
  delay?: number;
}

function parseArgs(): Args {
  const args = process.argv.slice(2);
  const result: Args = {
    volume: 1000,
    symbol: 'BTC-USDT',
    endpoint: 'http://localhost:3000/api/webhooks/exchange/okx',
    apiKey: 'mock-okx-api-key-12345',
    duplicate: false,
    delay: 1000,
  };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--volume':
        result.volume = parseFloat(args[++i]);
        break;
      case '--symbol':
        result.symbol = args[++i];
        break;
      case '--secret':
        result.secret = args[++i];
        break;
      case '--endpoint':
        result.endpoint = args[++i] ?? result.endpoint;
        break;
      case '--api-key':
        result.apiKey = args[++i];
        break;
      case '--timestamp':
        result.timestamp = parseInt(args[++i]);
        break;
      case '--duplicate':
        result.duplicate = true;
        break;
      case '--delay':
        result.delay = parseInt(args[++i]);
        break;
    }
  }

  return result;
}

export function generateOkxPayload(volume: number, symbol: string): Record<string, unknown> {
  // Extract base currency for price estimation
  const baseCurrency = symbol.split('-')[0];
  const priceMap: Record<string, number> = {
    'BTC': 60000,
    'ETH': 3000,
    'SOL': 150,
    'XRP': 0.5,
    'DOGE': 0.1,
  };
  const price = priceMap[baseCurrency] || 1000;
  const quantity = volume / price;

  return {
    instId: symbol,
    ordId: crypto.randomUUID(),
    sz: quantity.toFixed(6),
    px: price.toFixed(2),
    fee: (volume * 0.001).toFixed(4), // 0.1% fee
    side: 'buy',
    tradeId: crypto.randomUUID(),
    ts: Date.now().toString(),
  };
}

export function createOkxSignature(
  payload: string,
  timestamp: string | number,
  secret: string,
  method: string = 'POST',
  path: string = '/api/webhooks/exchange/okx'
): string {
  const signString = String(timestamp) + method.toUpperCase() + path + payload;
  return crypto.createHmac('sha256', secret).update(signString).digest('hex');
}

async function sendMockWebhook(args: Args): Promise<{ statusCode: number; body: string }> {
  const payload = generateOkxPayload(args.volume, args.symbol);
  const rawPayload = JSON.stringify(payload);
  const secret = args.secret || process.env.OKX_WEBHOOK_SECRET || 'test-secret';
  const timestamp = args.timestamp || Date.now();

  // Generate signature
  const signature = createOkxSignature(rawPayload, timestamp, secret);

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'OK-ACCESS-KEY': args.apiKey,
    'OK-ACCESS-SIGN': signature,
    'OK-ACCESS-TIMESTAMP': String(timestamp),
    'OK-ACCESS-PASSPHRASE': 'mock-passphrase',
  };

  console.log(`Sending mock OKX webhook:`);
  console.log('Payload:', JSON.stringify(payload, null, 2).slice(0, 500) + '...');
  console.log('Timestamp:', timestamp);
  console.log('Signature:', signature.slice(0, 20) + '...');
  console.log('API Key:', args.apiKey);
  console.log('Endpoint:', args.endpoint);

  const url = new URL(args.endpoint);
  const options = {
    hostname: url.hostname,
    port: url.port || (url.protocol === 'https:' ? 443 : 80),
    path: url.pathname + url.search,
    method: 'POST',
    headers,
  };

  const response = await new Promise<{ statusCode: number; body: string }>((resolve, reject) => {
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve({ statusCode: res.statusCode || 200, body: data }));
    });
    req.on('error', reject);
    req.write(rawPayload);
    req.end();
  });

  console.log(`\nResponse (${response.statusCode}):`, response.body);

  return response;
}

async function runDuplicateTest(args: Args): Promise<void> {
  console.log('=== DUPLICATE OKX WEBHOOK TEST ===');
  console.log('Testing replay protection by sending the same webhook twice');
  console.log(`Delay between sends: ${args.delay}ms`);
  console.log('');

  // First send
  console.log('【FIRST SEND】');
  const response1 = await sendMockWebhook(args);
  console.log('');

  // Wait for specified delay
  await new Promise(resolve => setTimeout(resolve, args.delay));

  // Second send (same payload)
  console.log('【SECOND SEND (DUPLICATE)】');
  const response2 = await sendMockWebhook(args);
  console.log('');

  // Compare results
  console.log('=== TEST RESULTS ===');
  console.log(`First response:  ${response1.statusCode} - ${response1.body.slice(0, 100)}`);
  console.log(`Second response: ${response2.statusCode} - ${response2.body.slice(0, 100)}`);

  try {
    const firstSuccess = JSON.parse(response1.body).success;
    const secondSkipped = JSON.parse(response2.body).skipped;

    if (firstSuccess && secondSkipped) {
      console.log('✅ REPLAY PROTECTION WORKING: First processed, second rejected as duplicate');
    } else if (firstSuccess && !secondSkipped) {
      console.log('❌ REPLAY PROTECTION FAILED: Both webhooks were processed');
    } else {
      console.log('❌ UNEXPECTED: First webhook failed');
    }
  } catch {
    console.log('❌ Could not parse responses as JSON');
  }
}

// Only run as script, not when imported for testing
if (import.meta.url === `file://${process.argv[1]}`) {
  const args = parseArgs();
  if (args.duplicate) {
    runDuplicateTest(args).catch(console.error);
  } else {
    sendMockWebhook(args).catch(console.error);
  }
}
