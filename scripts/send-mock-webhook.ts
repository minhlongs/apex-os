/**
 * Mock Webhook Sender - Testing Utility
 * Sends mock trade notifications to the webhook endpoint for testing
 *
 * USAGE:
 *   npx tsx scripts/send-mock-webhook.ts --exchange binance --volume 1000 --symbol BTCUSDT
 *   npx tsx scripts/send-mock-webhook.ts --exchange bybit --volume 500 --symbol ETHUSDT
 *   npx tsx scripts/send-mock-webhook.ts --duplicate --delay 2000  # Test replay protection
 *
 * FLAGS:
 *   --exchange    binance | bybit (default: binance)
 *   --volume      Trade volume in USD (default: 1000)
 *   --symbol      Trading pair (default: BTCUSDT)
 *   --secret      Webhook secret (uses env var if omitted)
 *   --endpoint    Webhook URL (default: http://localhost:3000/api/webhooks/exchange)
 *   --duplicate   Send same webhook twice to test replay protection
 *   --delay       Delay between duplicate sends in ms (default: 1000)
 *
 * ENV VARS:
 *   BINANCE_WEBHOOK_SECRET  Secret for Binance webhook verification
 *   BYBIT_WEBHOOK_SECRET    Secret for Bybit webhook verification
 *
 * REPLAY PROTECTION TEST:
 *   The --duplicate flag sends the identical webhook payload twice.
 *   Expected behavior:
 *     - First: 200 OK with conversion created
 *     - Second: 200 OK with {skipped: true, reason: "Duplicate webhook - replay detected"}
 *
 * Exportable functions for testing:
 *   - generateBinancePayload(volume, symbol)
 *   - generateBybitPayload(volume, symbol)
 *   - createSignature(payload, secret)
 */

import crypto from 'node:crypto'
import https from 'node:https'

export interface Args {
  exchange: 'binance' | 'bybit'
  volume: number
  symbol?: string
  secret?: string
  endpoint: string  // always defined with default
  duplicate?: boolean  // send same webhook twice to test replay protection
  delay?: number       // delay between duplicate sends in ms (default: 1000)
}

function parseArgs(): Args {
  const args = process.argv.slice(2)
  const result: Args = {
    exchange: 'binance',
    volume: 1000,
    symbol: 'BTCUSDT',
    endpoint: 'http://localhost:3000/api/webhooks/exchange',
    duplicate: false,
    delay: 1000,
  }

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--exchange':
        result.exchange = args[++i] as 'binance' | 'bybit'
        break
      case '--volume':
        result.volume = parseFloat(args[++i])
        break
      case '--symbol':
        result.symbol = args[++i]
        break
      case '--secret':
        result.secret = args[++i]
        break
      case '--endpoint':
        result.endpoint = args[++i] ?? result.endpoint
        break
      case '--duplicate':
        result.duplicate = true
        break
      case '--delay':
        result.delay = parseInt(args[++i])
        break
    }
  }

  return result
}

export function generateBinancePayload(volume: number, symbol: string): Record<string, unknown> {
  const quantity = volume / (symbol.includes('BTC') ? 60000 : 3000) // Rough estimate
  const price = symbol.includes('BTC') ? 60000 : 3000

  return {
    e: 'executionReport',
    E: Date.now(),
    s: symbol,
    o: {
      s: symbol,
      c: crypto.randomUUID(),
      S: 'BUY',
      o: 'MARKET',
      f: 'GTC',
      q: quantity.toFixed(6),
      p: price.toFixed(2),
      ap: price.toFixed(2),
      sp: '0',
      x: 'TRADE',
      X: 'FILLED',
      i: Math.floor(Math.random() * 1000000),
      l: quantity.toFixed(6),
      z: quantity.toFixed(6),
      L: price.toFixed(2),
      n: (volume * 0.001).toFixed(4), // 0.1% fee
      N: 'BNB',
      T: Date.now(),
      t: Math.floor(Math.random() * 1000000),
    },
    u: undefined, // User ID (would be populated by exchange)
  }
}

export function generateBybitPayload(volume: number, symbol: string): Record<string, unknown> {
  const quantity = volume / (symbol.includes('BTC') ? 60000 : 3000)
  const price = symbol.includes('BTC') ? 60000 : 3000

  return {
    symbol,
    side: 'Buy',
    size: quantity.toFixed(6),
    price: price.toFixed(2),
    avgPrice: price.toFixed(2),
    execType: 'Trade',
    orderType: 'Market',
    orderId: crypto.randomUUID(),
    fee: (volume * 0.001).toFixed(4), // 0.1% fee
    feeCurrency: 'USDT',
    execTime: Date.now().toString(),
    transactTime: Date.now().toString(),
    tradeId: Math.floor(Math.random() * 1000000).toString(),
    accountId: 'mock-account-' + Math.floor(Math.random() * 1000),
    category: 'spot',
  }
}

export function createSignature(payload: string, secret: string): string {
  return crypto.createHmac('sha256', secret).update(payload).digest('hex')
}

async function sendMockWebhook(args: Args): Promise<{ statusCode: number; body: string }> {
  const payload =
    args.exchange === 'binance'
      ? generateBinancePayload(args.volume, args.symbol || 'BTCUSDT')
      : generateBybitPayload(args.volume, args.symbol || 'BTCUSDT')

  const rawPayload = JSON.stringify(payload)
  const secret = args.secret || process.env[args.exchange === 'binance' ? 'BINANCE_WEBHOOK_SECRET' : 'BYBIT_WEBHOOK_SECRET'] || 'test-secret'

  let signatureHeader: string

  if (args.exchange === 'binance') {
    signatureHeader = createSignature(rawPayload, secret)
  } else {
    // Bybit: timestamp + method + path + body
    const timestamp = Date.now().toString()
    const method = 'POST'
    const path = '/api/webhooks/exchange'
    const signString = timestamp + method + path + rawPayload
    signatureHeader = createSignature(signString, secret)
  }

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  }

  if (args.exchange === 'binance') {
    headers['X-Binance-Signature'] = signatureHeader
  } else {
    headers['X-Bybit-HMAC-Signature'] = signatureHeader
    headers['X-Bybit-Signature-Timestamp'] = Date.now().toString()
  }

  console.log(`Sending mock ${args.exchange} webhook:`)
  console.log('Payload:', JSON.stringify(payload, null, 2).slice(0, 500) + '...')
  console.log('Signature:', signatureHeader.slice(0, 20) + '...')
  console.log('Endpoint:', args.endpoint)

  const url = new URL(args.endpoint)
  const options = {
    hostname: url.hostname,
    port: url.port || (url.protocol === 'https:' ? 443 : 80),
    path: url.pathname + url.search,
    method: 'POST',
    headers,
  }

  const response = await new Promise<{ statusCode: number; body: string }>((resolve, reject) => {
    const req = https.request(options, (res) => {
      let data = ''
      res.on('data', chunk => data += chunk)
      res.on('end', () => resolve({ statusCode: res.statusCode || 200, body: data }))
    })
    req.on('error', reject)
    req.write(rawPayload)
    req.end()
  })

  console.log(`\nResponse (${response.statusCode}):`, response.body)

  return response
}

async function runDuplicateTest(args: Args): Promise<void> {
  console.log('=== DUPLICATE WEBHOOK TEST ===')
  console.log('Testing replay protection by sending the same webhook twice')
  console.log(`Delay between sends: ${args.delay}ms`)
  console.log('')

  // First send
  console.log('【FIRST SEND】')
  const response1 = await sendMockWebhook(args)
  console.log('')

  // Wait for specified delay
  await new Promise(resolve => setTimeout(resolve, args.delay))

  // Second send (same payload)
  console.log('【SECOND SEND (DUPLICATE)】')
  const response2 = await sendMockWebhook(args)
  console.log('')

  // Compare results
  console.log('=== TEST RESULTS ===')
  console.log(`First response:  ${response1.statusCode} - ${response1.body.slice(0, 100)}`)
  console.log(`Second response: ${response2.statusCode} - ${response2.body.slice(0, 100)}`)

  if (response1.statusCode === response2.statusCode) {
    console.log('⚠️  Both responses have same status code')
  } else {
    console.log('✓ Different status codes (expected: first 200, second 200 with skipped:true)')
  }

  const firstSuccess = JSON.parse(response1.body).success
  const secondSkipped = JSON.parse(response2.body).skipped

  if (firstSuccess && secondSkipped) {
    console.log('✅ REPLAY PROTECTION WORKING: First processed, second rejected as duplicate')
  } else if (firstSuccess && !secondSkipped) {
    console.log('❌ REPLAY PROTECTION FAILED: Both webhooks were processed')
  } else {
    console.log('❌ UNEXPECTED: First webhook failed')
  }
}

// Only run as script, not when imported for testing
const isDirectRun = (() => {
  try {
    return (typeof process !== 'undefined' && typeof process.argv !== 'undefined') && (typeof importMetaUrl !== 'undefined' ? importMetaUrl === `file://${process.argv[1]}` : false);
  } catch {
    return false;
  }
})();
if (isDirectRun) {
  const args = parseArgs()
  if (args.duplicate) {
    runDuplicateTest(args).catch(console.error)
  } else {
    sendMockWebhook(args).catch(console.error)
  }
}
