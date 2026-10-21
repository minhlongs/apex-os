// Enforces the Node.js runtime the test suite and production build were proven on.
//
// Why this exists: better-sqlite3 ships a native binding compiled for a specific
// Node ABI. On an older runtime the binding fails to load, which surfaces as ~443
// confusing test failures that look like product bugs but are a toolchain mismatch.
// Failing fast with one clear message is better than 443 misleading ones.
//
// Invariant: the running Node must satisfy the declared engine range. Warnings are
// useless here — a mismatched ABI must stop the run, not be printed and ignored.

const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..');

function fail(message) {
  process.stderr.write(`\n✖ ${message}\n\n`);
  process.exit(1);
}

function readJson(relativePath) {
  const full = path.join(REPO_ROOT, relativePath);
  return JSON.parse(fs.readFileSync(full, 'utf8'));
}

function parseMajorMinor(version) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(version.trim());
  if (!match) {
    return null;
  }
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
  };
}

function satisfiesRange(version, range) {
  const parsed = parseMajorMinor(version);
  if (!parsed) {
    return false;
  }

  // Only the forms actually used in package.json "engines" need to work here:
  //   ">=26.0.0 <27", "26.x", "^26.7.0"
  const clauses = range.split(/\s+/).filter(Boolean);
  return clauses.every((clause) => satisfiesClause(parsed, clause));
}

function satisfiesClause(parsed, clause) {
  const gte = /^>=\s*(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(clause);
  if (gte) {
    const floor = {
      major: Number(gte[1]),
      minor: Number(gte[2] ?? 0),
      patch: Number(gte[3] ?? 0),
    };
    return compare(parsed, floor) >= 0;
  }

  const lt = /^<\s*(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(clause);
  if (lt) {
    const ceiling = {
      major: Number(lt[1]),
      minor: Number(lt[2] ?? 0),
      patch: Number(lt[3] ?? 0),
    };
    return compare(parsed, ceiling) < 0;
  }

  const caret = /^\^\s*(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(clause);
  if (caret) {
    const floor = {
      major: Number(caret[1]),
      minor: Number(caret[2] ?? 0),
      patch: Number(caret[3] ?? 0),
    };
    return parsed.major === floor.major && compare(parsed, floor) >= 0;
  }

  return parsed.major === Number(clause.replace(/\D/g, ''));
}

function compare(a, b) {
  if (a.major !== b.major) return a.major - b.major;
  if (a.minor !== b.minor) return a.minor - b.minor;
  return a.patch - b.patch;
}

function main() {
  const pkg = readJson('package.json');
  const engines = pkg.engines ?? {};
  const expected = engines.node;

  if (!expected) {
    fail(
      'package.json is missing "engines.node". Declare the supported Node range so the ' +
        'test suite and production build run on the ABI they were proven on.'
    );
  }

  const actual = process.version;

  if (!satisfiesRange(actual, expected)) {
    fail(
      `Node ${actual} does not satisfy engines.node "${expected}".\n` +
        `  Required : ${expected}\n` +
        `  Running  : ${actual}\n\n` +
        `Fix: use the pinned runtime, then re-run.\n` +
        `  fnm use 26         (or: nvm use 26)\n` +
        `  Homebrew keg: export PATH=/opt/homebrew/opt/node@26/bin:$PATH\n\n` +
        `Running anyway produces hundreds of unrelated native-module load errors.`
    );
  }

  const declaredNvmrc = fs
    .readFileSync(path.join(REPO_ROOT, '.nvmrc'), 'utf8')
    .trim();
  const runtimeMajor = parseMajorMinor(actual);

  if (declaredNvmrc && runtimeMajor) {
    const pinned = parseMajorMinor(declaredNvmrc);
    if (pinned && runtimeMajor.major !== pinned.major) {
      fail(
        `.nvmrc pins Node ${declaredNvmrc} but the running runtime is ${actual}. ` +
          `Use the version recorded in .nvmrc so local runs match CI and production.`
      );
    }
  }

  process.stdout.write(
    `✓ Node ${actual} satisfies engines.node "${expected}"\n`
  );
}

main();
