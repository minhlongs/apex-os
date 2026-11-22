#!/usr/bin/env bash
set -euo pipefail

# scripts/assert-staging-isolation.sh
# Bidirectional fail-closed isolation verifier between production (wrangler.jsonc)
# and staging (wrangler.staging.jsonc).
#
# Usage:
#   bash scripts/assert-staging-isolation.sh [staging_config] [prod_config]
#
# Fails closed (non-zero exit) if production and staging share or cross-contaminate:
#   - Worker script name
#   - D1 database_id or database_name
#   - KV namespace id
#   - R2 bucket_name
#   - Durable Object script_name cross-binding (staging DO pointing to prod worker or vice versa)
#   - Custom routes / custom_domains
#   - APP_ENV ("staging" vs "production")
#   - NEXT_PUBLIC_APP_URL
#   - WEBAUTHN_RP_ID
#   - WEBAUTHN_ORIGIN
#   - STELLAR_NETWORK ("testnet" on staging vs "mainnet" on production)

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
STAGING_CONFIG="${1:-${REPO_ROOT}/wrangler.staging.jsonc}"
PROD_CONFIG="${2:-${REPO_ROOT}/wrangler.jsonc}"

if [[ ! -f "${STAGING_CONFIG}" ]]; then
  echo "ERROR: Staging config not found at ${STAGING_CONFIG}" >&2
  exit 1
fi

if [[ ! -f "${PROD_CONFIG}" ]]; then
  echo "ERROR: Production config not found at ${PROD_CONFIG}" >&2
  exit 1
fi

node - "${STAGING_CONFIG}" "${PROD_CONFIG}" <<'NODE_EOF'
const fs = require('node:fs');
const vm = require('node:vm');

const [stagingPath, prodPath] = process.argv.slice(2);

const EXPECTED = {
  prod: {
    name: 'apex-os',
    dbId: '3436aa7d-3065-4103-96e1-ddbd8b372246',
    dbName: 'apex-os-db',
    kvId: '5628adf57f1548b5af615de4e9021893',
    r2Bucket: 'apex-os-uploads',
    appEnv: 'production',
    stellarNetwork: 'mainnet',
  },
  staging: {
    name: 'apex-os-staging',
    dbId: 'be4ed659-c877-4820-ae6e-9747bc7ee316',
    dbName: 'apex-os-staging-db',
    kvId: 'f2cf595dec5543dc96f6370bebbc8754',
    r2Bucket: 'apex-os-uploads-staging',
    appEnv: 'staging',
    stellarNetwork: 'testnet',
  },
};

function stripJsonComments(input) {
  let out = '';
  let inString = false;
  let escape = false;
  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i];
    const next = input[i + 1];
    if (inString) {
      out += ch;
      if (escape) {
        escape = false;
      } else if (ch === '\\') {
        escape = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      continue;
    }
    if (ch === '/' && next === '/') {
      while (i < input.length && input[i] !== '\n') i += 1;
      out += '\n';
      continue;
    }
    if (ch === '/' && next === '*') {
      i += 2;
      while (i < input.length && !(input[i] === '*' && input[i + 1] === '/')) i += 1;
      i += 1;
      continue;
    }
    out += ch;
  }
  // Strip trailing commas before } or ]
  return out.replace(/,\s*([}\]])/g, '$1');
}

function parseJsonc(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8');
  try {
    return JSON.parse(stripJsonComments(raw));
  } catch (err) {
    throw new Error(`Invalid JSONC in ${filePath}: ${err.message}`);
  }
}

function fail(msg) {
  console.error(`FATAL: ${msg}`);
  process.exit(1);
}

let staging;
let prod;
try {
  staging = parseJsonc(stagingPath);
  prod = parseJsonc(prodPath);
} catch (err) {
  fail(err.message);
}

// 1. Worker script name isolation
if (staging.name !== EXPECTED.staging.name) {
  fail(`Expected staging worker name "${EXPECTED.staging.name}", got "${staging.name}" in ${stagingPath}`);
}
if (prod.name !== EXPECTED.prod.name) {
  fail(`Expected production worker name "${EXPECTED.prod.name}", got "${prod.name}" in ${prodPath}`);
}
if (staging.name === prod.name) {
  fail(`Staging and production share worker name "${staging.name}"`);
}

// 2. D1 database isolation
const stagingDbs = Array.isArray(staging.d1_databases) ? staging.d1_databases : [];
const prodDbs = Array.isArray(prod.d1_databases) ? prod.d1_databases : [];
if (stagingDbs.length === 0 || prodDbs.length === 0) {
  fail('Both staging and production configs must declare non-empty d1_databases bindings');
}
const stagingDbIds = new Set(stagingDbs.map((d) => d.database_id));
const prodDbIds = new Set(prodDbs.map((d) => d.database_id));
const stagingDbNames = new Set(stagingDbs.map((d) => d.database_name));
const prodDbNames = new Set(prodDbs.map((d) => d.database_name));

if (!stagingDbIds.has(EXPECTED.staging.dbId)) {
  fail(`Expected staging D1 database_id (${EXPECTED.staging.dbId}) missing from ${stagingPath}`);
}
if (!prodDbIds.has(EXPECTED.prod.dbId)) {
  fail(`Expected production D1 database_id (${EXPECTED.prod.dbId}) missing from ${prodPath}`);
}
if (!stagingDbNames.has(EXPECTED.staging.dbName)) {
  fail(`Expected staging D1 database_name (${EXPECTED.staging.dbName}) missing from ${stagingPath}`);
}
if (!prodDbNames.has(EXPECTED.prod.dbName)) {
  fail(`Expected production D1 database_name (${EXPECTED.prod.dbName}) missing from ${prodPath}`);
}
for (const id of stagingDbIds) {
  if (prodDbIds.has(id)) {
    fail(`Shared D1 database_id (${id}) detected between staging and production`);
  }
}
for (const name of stagingDbNames) {
  if (prodDbNames.has(name)) {
    fail(`Shared D1 database_name (${name}) detected between staging and production`);
  }
}

// 3. KV namespace isolation
const stagingKvs = Array.isArray(staging.kv_namespaces) ? staging.kv_namespaces : [];
const prodKvs = Array.isArray(prod.kv_namespaces) ? prod.kv_namespaces : [];
if (stagingKvs.length === 0 || prodKvs.length === 0) {
  fail('Both staging and production configs must declare non-empty kv_namespaces bindings');
}
const stagingKvIds = new Set(stagingKvs.map((k) => k.id));
const prodKvIds = new Set(prodKvs.map((k) => k.id));

if (!stagingKvIds.has(EXPECTED.staging.kvId)) {
  fail(`Expected staging KV namespace (${EXPECTED.staging.kvId}) missing from ${stagingPath}`);
}
if (!prodKvIds.has(EXPECTED.prod.kvId)) {
  fail(`Expected production KV namespace (${EXPECTED.prod.kvId}) missing from ${prodPath}`);
}
for (const id of stagingKvIds) {
  if (prodKvIds.has(id)) {
    fail(`Shared KV namespace id (${id}) detected between staging and production`);
  }
}

// 4. R2 bucket isolation
const stagingR2 = Array.isArray(staging.r2_buckets) ? staging.r2_buckets : [];
const prodR2 = Array.isArray(prod.r2_buckets) ? prod.r2_buckets : [];
if (stagingR2.length === 0 || prodR2.length === 0) {
  fail('Both staging and production configs must declare non-empty r2_buckets bindings');
}
const stagingBuckets = new Set(stagingR2.map((b) => b.bucket_name));
const prodBuckets = new Set(prodR2.map((b) => b.bucket_name));

if (!stagingBuckets.has(EXPECTED.staging.r2Bucket)) {
  fail(`Expected staging R2 bucket (${EXPECTED.staging.r2Bucket}) missing from ${stagingPath}`);
}
if (!prodBuckets.has(EXPECTED.prod.r2Bucket)) {
  fail(`Expected production R2 bucket (${EXPECTED.prod.r2Bucket}) missing from ${prodPath}`);
}
for (const b of stagingBuckets) {
  if (prodBuckets.has(b)) {
    fail(`Shared R2 bucket_name (${b}) detected between staging and production`);
  }
  if (b.includes('preview_bucket_name')) {
    fail(`Unexpected preview bucket contamination in ${b}`);
  }
}
for (const b of stagingR2) {
  if (b.preview_bucket_name && prodBuckets.has(b.preview_bucket_name)) {
    fail(`Staging R2 preview_bucket_name (${b.preview_bucket_name}) points at production R2 bucket`);
  }
}
for (const b of prodR2) {
  if (b.preview_bucket_name && stagingBuckets.has(b.preview_bucket_name)) {
    fail(`Production R2 preview_bucket_name (${b.preview_bucket_name}) points at staging R2 bucket`);
  }
}

// 5. Durable Object cross-script isolation
// Local DO bindings inherit the Worker's own script namespace (`apex-os-staging` vs `apex-os`),
// which Cloudflare isolates per Worker script. Fail if `script_name` points across environments.
const stagingDos = staging.durable_objects?.bindings ?? [];
const prodDos = prod.durable_objects?.bindings ?? [];
for (const binding of stagingDos) {
  if (binding.script_name && binding.script_name === prod.name) {
    fail(`Staging Durable Object "${binding.name}" binds to production script_name "${prod.name}"`);
  }
}
for (const binding of prodDos) {
  if (binding.script_name && binding.script_name === staging.name) {
    fail(`Production Durable Object "${binding.name}" binds to staging script_name "${staging.name}"`);
  }
}

// 6. Routes / custom_domains isolation
function extractRoutePatterns(cfg) {
  const patterns = [];
  if (typeof cfg.route === 'string' && cfg.route.trim()) patterns.push(cfg.route.trim());
  if (cfg.route && typeof cfg.route === 'object' && cfg.route.pattern) patterns.push(String(cfg.route.pattern).trim());
  if (Array.isArray(cfg.routes)) {
    for (const r of cfg.routes) {
      if (typeof r === 'string' && r.trim()) patterns.push(r.trim());
      else if (r && typeof r === 'object' && r.pattern) patterns.push(String(r.pattern).trim());
    }
  }
  if (Array.isArray(cfg.custom_domains)) {
    for (const d of cfg.custom_domains) {
      if (typeof d === 'string' && d.trim()) patterns.push(d.trim());
    }
  }
  return patterns;
}

const stagingRoutes = new Set(extractRoutePatterns(staging));
const prodRoutes = new Set(extractRoutePatterns(prod));
for (const route of stagingRoutes) {
  if (prodRoutes.has(route)) {
    fail(`Shared route/custom_domain "${route}" detected between staging and production`);
  }
}

// 7. Environment & origin/WebAuthn variable isolation
const sVars = staging.vars ?? {};
const pVars = prod.vars ?? {};

if (sVars.APP_ENV !== EXPECTED.staging.appEnv) {
  fail(`Staging vars.APP_ENV must be "${EXPECTED.staging.appEnv}", got "${sVars.APP_ENV}"`);
}
if (pVars.APP_ENV !== EXPECTED.prod.appEnv) {
  fail(`Production vars.APP_ENV must be "${EXPECTED.prod.appEnv}", got "${pVars.APP_ENV}"`);
}

for (const key of ['NEXT_PUBLIC_APP_URL', 'WEBAUTHN_RP_ID', 'WEBAUTHN_ORIGIN']) {
  const sVal = typeof sVars[key] === 'string' ? sVars[key].trim() : '';
  const pVal = typeof pVars[key] === 'string' ? pVars[key].trim() : '';
  if (!sVal) fail(`Staging vars.${key} must be explicitly defined and non-empty`);
  if (!pVal) fail(`Production vars.${key} must be explicitly defined and non-empty`);
  if (sVal === pVal) {
    fail(`Staging and production share identical vars.${key} ("${sVal}")`);
  }
}

// Validate URL <-> RP_ID consistency and HTTPS enforcement
function validateOriginAndRpId(label, varsObj) {
  let appUrl;
  let originUrl;
  try {
    appUrl = new URL(varsObj.NEXT_PUBLIC_APP_URL);
  } catch {
    fail(`${label} vars.NEXT_PUBLIC_APP_URL ("${varsObj.NEXT_PUBLIC_APP_URL}") is not a valid URL`);
  }
  try {
    originUrl = new URL(varsObj.WEBAUTHN_ORIGIN);
  } catch {
    fail(`${label} vars.WEBAUTHN_ORIGIN ("${varsObj.WEBAUTHN_ORIGIN}") is not a valid URL`);
  }
  if (appUrl.protocol !== 'https:' || originUrl.protocol !== 'https:') {
    fail(`${label} NEXT_PUBLIC_APP_URL and WEBAUTHN_ORIGIN must use https://`);
  }
  if (appUrl.origin !== originUrl.origin) {
    fail(`${label} NEXT_PUBLIC_APP_URL origin (${appUrl.origin}) does not match WEBAUTHN_ORIGIN (${originUrl.origin})`);
  }
  const rpId = varsObj.WEBAUTHN_RP_ID;
  if (rpId === 'localhost' || rpId === 'workers.dev' || rpId.includes('://') || rpId.includes('/')) {
    fail(`${label} WEBAUTHN_RP_ID ("${rpId}") is invalid or uses bare public suffix`);
  }
  const host = originUrl.hostname.toLowerCase();
  const normalizedRp = rpId.toLowerCase();
  if (!(host === normalizedRp || host.endsWith(`.${normalizedRp}`))) {
    fail(`${label} WEBAUTHN_ORIGIN host (${host}) is not registrable under WEBAUTHN_RP_ID (${normalizedRp})`);
  }
  const unownedDomains = ['apexos.app', 'apex-os.pages.dev', 'apex-os.com', 'apexos.io', 'long-tran624.workers.dev'];
  for (const bad of unownedDomains) {
    if (host === bad || host.endsWith(`.${bad}`)) {
      fail(`${label} references unverified/third-party domain "${bad}" in ${host}`);
    }
  }
}

validateOriginAndRpId('Staging', sVars);
validateOriginAndRpId('Production', pVars);

if (sVars.STELLAR_NETWORK && sVars.STELLAR_NETWORK !== EXPECTED.staging.stellarNetwork) {
  fail(`Staging vars.STELLAR_NETWORK must be "${EXPECTED.staging.stellarNetwork}", got "${sVars.STELLAR_NETWORK}"`);
}
if (pVars.STELLAR_NETWORK && pVars.STELLAR_NETWORK !== EXPECTED.prod.stellarNetwork) {
  fail(`Production vars.STELLAR_NETWORK must be "${EXPECTED.prod.stellarNetwork}", got "${pVars.STELLAR_NETWORK}"`);
}
if (sVars.AUTO_SETTLE_PAYOUTS !== 'false') {
  fail(`Staging vars.AUTO_SETTLE_PAYOUTS must fail-closed ("false"), got "${sVars.AUTO_SETTLE_PAYOUTS}"`);
}
if (pVars.AUTO_SETTLE_PAYOUTS !== 'false') {
  fail(`Production vars.AUTO_SETTLE_PAYOUTS must fail-closed ("false"), got "${pVars.AUTO_SETTLE_PAYOUTS}"`);
}

console.log('STAGING_ISOLATED');
NODE_EOF
