import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const REPO_ROOT = path.resolve(__dirname, '..');
const SCRIPT_PATH = path.join(REPO_ROOT, 'scripts', 'assert-staging-isolation.sh');
const REAL_STAGING = path.join(REPO_ROOT, 'wrangler.staging.jsonc');
const REAL_PROD = path.join(REPO_ROOT, 'wrangler.jsonc');

function stripComments(raw: string): string {
  let out = '';
  let inString = false;
  let escape = false;
  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i];
    const next = raw[i + 1];
    if (inString) {
      out += ch;
      if (escape) escape = false;
      else if (ch === '\\') escape = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      continue;
    }
    if (ch === '/' && next === '/') {
      while (i < raw.length && raw[i] !== '\n') i += 1;
      out += '\n';
      continue;
    }
    if (ch === '/' && next === '*') {
      i += 2;
      while (i < raw.length && !(raw[i] === '*' && raw[i + 1] === '/')) i += 1;
      i += 1;
      continue;
    }
    out += ch;
  }
  return out.replace(/,\s*([}\]])/g, '$1');
}

function loadConfig(filePath: string): Record<string, any> {
  return JSON.parse(stripComments(fs.readFileSync(filePath, 'utf8')));
}

function runIsolationScript(stagingFile: string, prodFile: string): {
  ok: boolean;
  stdout: string;
  stderr: string;
  status: number;
} {
  try {
    const stdout = execFileSync('bash', [SCRIPT_PATH, stagingFile, prodFile], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { ok: true, stdout, stderr: '', status: 0 };
  } catch (err: any) {
    return {
      ok: false,
      stdout: err.stdout?.toString?.() ?? '',
      stderr: err.stderr?.toString?.() ?? '',
      status: err.status ?? 1,
    };
  }
}

describe('scripts/assert-staging-isolation.sh', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'apex-isolation-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function writePair(
    mutateStaging?: (cfg: Record<string, any>) => void,
    mutateProd?: (cfg: Record<string, any>) => void,
  ): { stagingPath: string; prodPath: string } {
    const s = loadConfig(REAL_STAGING);
    const p = loadConfig(REAL_PROD);
    if (mutateStaging) mutateStaging(s);
    if (mutateProd) mutateProd(p);
    const stagingPath = path.join(tmpDir, 'wrangler.staging.jsonc');
    const prodPath = path.join(tmpDir, 'wrangler.jsonc');
    fs.writeFileSync(stagingPath, JSON.stringify(s, null, 2));
    fs.writeFileSync(prodPath, JSON.stringify(p, null, 2));
    return { stagingPath, prodPath };
  }

  it('passes on the real repository wrangler.staging.jsonc and wrangler.jsonc', () => {
    const res = runIsolationScript(REAL_STAGING, REAL_PROD);
    expect(res.ok).toBe(true);
    expect(res.stdout.trim()).toBe('STAGING_ISOLATED');
  });

  it('fails closed when staging binds production D1 database_id (even inside comments vs JSON parsed)', () => {
    const { stagingPath, prodPath } = writePair((s) => {
      s.d1_databases[0].database_id = '3436aa7d-3065-4103-96e1-ddbd8b372246';
    });
    const res = runIsolationScript(stagingPath, prodPath);
    expect(res.ok).toBe(false);
    expect(res.stderr).toMatch(/D1 database_id/i);
  });

  it('fails closed when production binds staging KV namespace id', () => {
    const { stagingPath, prodPath } = writePair(undefined, (p) => {
      p.kv_namespaces[0].id = 'f2cf595dec5543dc96f6370bebbc8754';
    });
    const res = runIsolationScript(stagingPath, prodPath);
    expect(res.ok).toBe(false);
    expect(res.stderr).toMatch(/KV namespace/i);
  });

  it('fails closed when staging R2 bucket or preview_bucket_name points to production bucket', () => {
    const { stagingPath, prodPath } = writePair((s) => {
      s.r2_buckets[0].preview_bucket_name = 'apex-os-uploads';
    });
    const res = runIsolationScript(stagingPath, prodPath);
    expect(res.ok).toBe(false);
    expect(res.stderr).toMatch(/preview_bucket_name|R2 bucket/i);
  });

  it('fails closed when Durable Object script_name cross-binds staging to production worker', () => {
    const { stagingPath, prodPath } = writePair((s) => {
      s.durable_objects.bindings[0].script_name = 'apex-os';
    });
    const res = runIsolationScript(stagingPath, prodPath);
    expect(res.ok).toBe(false);
    expect(res.stderr).toMatch(/Durable Object/i);
  });

  it('fails closed when staging and production share a custom route or domain', () => {
    const { stagingPath, prodPath } = writePair(
      (s) => {
        s.custom_domains = ['app.agencyos.network'];
      },
      (p) => {
        p.custom_domains = ['app.agencyos.network'];
      },
    );
    const res = runIsolationScript(stagingPath, prodPath);
    expect(res.ok).toBe(false);
    expect(res.stderr).toMatch(/Shared route\/custom_domain/i);
  });

  it('fails closed when APP_ENV is misconfigured on staging or production', () => {
    const { stagingPath, prodPath } = writePair((s) => {
      s.vars.APP_ENV = 'production';
    });
    const res = runIsolationScript(stagingPath, prodPath);
    expect(res.ok).toBe(false);
    expect(res.stderr).toMatch(/APP_ENV/i);
  });

  it('fails closed when NEXT_PUBLIC_APP_URL, WEBAUTHN_RP_ID, or WEBAUTHN_ORIGIN match across environments', () => {
    const { stagingPath, prodPath } = writePair((s) => {
      s.vars.NEXT_PUBLIC_APP_URL = 'https://apex-os.agencyos-openclaw.workers.dev';
      s.vars.WEBAUTHN_RP_ID = 'apex-os.agencyos-openclaw.workers.dev';
      s.vars.WEBAUTHN_ORIGIN = 'https://apex-os.agencyos-openclaw.workers.dev';
    });
    const res = runIsolationScript(stagingPath, prodPath);
    expect(res.ok).toBe(false);
    expect(res.stderr).toMatch(/share identical vars/i);
  });

  it('fails closed when WEBAUTHN_RP_ID uses bare workers.dev public suffix or unowned domain', () => {
    const bareSuffix = writePair((s) => {
      s.vars.WEBAUTHN_RP_ID = 'workers.dev';
    });
    const res1 = runIsolationScript(bareSuffix.stagingPath, bareSuffix.prodPath);
    expect(res1.ok).toBe(false);
    expect(res1.stderr).toMatch(/WEBAUTHN_RP_ID/i);

    const thirdParty = writePair((s) => {
      s.vars.NEXT_PUBLIC_APP_URL = 'https://apexos.app';
      s.vars.WEBAUTHN_ORIGIN = 'https://apexos.app';
      s.vars.WEBAUTHN_RP_ID = 'apexos.app';
    });
    const res2 = runIsolationScript(thirdParty.stagingPath, thirdParty.prodPath);
    expect(res2.ok).toBe(false);
    expect(res2.stderr).toMatch(/unverified\/third-party domain/i);
  });

  it('fails closed when STELLAR_NETWORK on staging is mainnet or AUTO_SETTLE_PAYOUTS is true', () => {
    const { stagingPath, prodPath } = writePair((s) => {
      s.vars.STELLAR_NETWORK = 'mainnet';
    });
    const res = runIsolationScript(stagingPath, prodPath);
    expect(res.ok).toBe(false);
    expect(res.stderr).toMatch(/STELLAR_NETWORK/i);
  });
});
