#!/usr/bin/env node

/**
 * Pre-deploy assertion for the Worker configuration.
 *
 * wrangler.jsonc binds both the production D1 database and the staging D1
 * database in the same config, so any deploy carries production credentials
 * into scope. That is a deliberate arrangement (staging code reads the staging
 * binding by name), but it means a deploy against the wrong environment is not
 * a config error — it succeeds and writes to production data.
 *
 * This guard refuses to pass the conditions that make that mistake possible:
 *   1. more than one deploy config exists in the repo, and
 *   2. the two D1 bindings resolve to the same database id.
 *
 * Run it before any deploy. It is read-only and exits non-zero on a problem.
 */

const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..');
const CONFIG_NAMES = ['wrangler.jsonc', 'wrangler.json', 'wrangler.toml'];

function fail(message) {
  process.stderr.write(`\n✖ Deploy config check failed: ${message}\n\n`);
  process.exit(1);
}

function pass(message) {
  process.stdout.write(`✓ ${message}\n`);
}

function stripJsonComments(raw) {
  let out = '';
  let inString = false;
  let inLineComment = false;
  let inBlockComment = false;

  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i];
    const next = raw[i + 1];

    if (inLineComment) {
      if (ch === '\n') {
        inLineComment = false;
        out += ch;
      }
      continue;
    }

    if (inBlockComment) {
      if (ch === '*' && next === '/') {
        inBlockComment = false;
        i += 1;
      }
      continue;
    }

    if (inString) {
      if (ch === '\\') {
        out += ch + (next ?? '');
        i += 1;
        continue;
      }
      if (ch === '"') {
        inString = false;
      }
      out += ch;
      continue;
    }

    if (ch === '"') {
      inString = true;
      out += ch;
      continue;
    }

    if (ch === '/' && next === '/') {
      inLineComment = true;
      i += 1;
      continue;
    }

    if (ch === '/' && next === '*') {
      inBlockComment = true;
      i += 1;
      continue;
    }

    out += ch;
  }

  // Trailing commas are tolerated here because the config is hand-maintained.
  return out.replace(/,(\s*[}\]])/g, '$1');
}

function readConfig(fileName) {
  const full = path.join(REPO_ROOT, fileName);
  if (fileName.endsWith('.toml')) {
    return null;
  }
  const raw = fs.readFileSync(full, 'utf8');
  return JSON.parse(stripJsonComments(raw));
}

function main() {
  const present = CONFIG_NAMES.filter((name) =>
    fs.existsSync(path.join(REPO_ROOT, name))
  );

  if (present.length > 1) {
    fail(
      `multiple deploy configs present (${present.join(', ')}). ` +
        'Wrangler prefers one and silently ignores the other, so two live ' +
        'configs make the deployed bindings ambiguous. Keep exactly one.'
    );
  }

  const configName = present[0];
  if (!configName) {
    fail('no wrangler config found (expected wrangler.jsonc).');
  }

  const config = readConfig(configName);
  const databases = (config.d1_databases ?? []).map((db) => ({
    binding: db.binding,
    databaseName: db.database_name,
    databaseId: db.database_id,
  }));

  if (databases.length === 0) {
    fail(`${configName} binds no D1 database; payouts and the app need one.`);
  }

  const missingId = databases.find((db) => !db.databaseId);
  if (missingId) {
    fail(
      `D1 binding "${missingId.binding}" has no database_id. Wrangler requires ` +
        'a database_id to target an existing database.'
    );
  }

  const duplicates = databases.filter((db, index) =>
    databases.findIndex((other) => other.databaseId === db.databaseId) !== index
  );
  if (duplicates.length > 0) {
    fail(
      `database_id ${duplicates[0].databaseId} is bound more than once ` +
        `(${duplicates.map((d) => d.binding).join(', ')}). ` +
        'Two names for one database means a staging code path can write to ' +
        'production rows.'
    );
  }

  const prodBinding = databases.find((db) => db.binding === 'DB');
  const stagingBinding = databases.find((db) => db.binding !== 'DB');

  if (prodBinding && stagingBinding && prodBinding.databaseId === stagingBinding.databaseId) {
    fail(
      `production binding "DB" and staging binding "${stagingBinding.binding}" ` +
        'resolve to the same database_id.'
    );
  }

  // Warn (do not fail) when staging is reachable from the same config, because
  // that is the expected shape and must not block a legitimate deploy.
  if (stagingBinding) {
    process.stdout.write(
      `! note: ${configName} also binds "${stagingBinding.binding}" ` +
        `(${stagingBinding.databaseName}). Production code must reference the ` +
        '"DB" binding only.\n'
    );
  }

  pass(
    `${configName} binds ${databases.length} distinct D1 ` +
      `database${databases.length === 1 ? '' : 's'} with unique ids.`
  );
}

main();
