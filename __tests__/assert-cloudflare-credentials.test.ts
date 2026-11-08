/**
 * Guards the deploy credential preflight and the secret names the workflow reads.
 *
 * The deploy failure this suite exists to prevent was invisible at review time:
 * the workflow mapped `secrets.CF_API_TOKEN` into `CLOUDFLARE_API_TOKEN`, a
 * secret name the repository never had, so wrangler received an empty variable
 * and reported the *variable* as missing. Nine consecutive failed deploy
 * workflows read that as "the credential does not exist" when the real cause was
 * a name mismatch that git could not see.
 *
 * A rename of either side is exactly the kind of edit that reintroduces it, so
 * the pairing is asserted from the workflow text rather than assumed.
 */

import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';

const REPO_ROOT = path.resolve(__dirname, '..');
const SCRIPT = path.join(REPO_ROOT, 'scripts', 'assert-cloudflare-credentials.sh');
const WORKFLOW = path.join(REPO_ROOT, '.github', 'workflows', 'deploy.yml');

/** Runs the preflight with a caller-supplied environment, capturing its exit code. */
function runPreflight(env: Record<string, string | undefined>): {
  status: number;
  stdout: string;
  stderr: string;
} {
  const base: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) {
      base[key] = value;
    }
  }

  try {
    const stdout = execFileSync('bash', [SCRIPT], {
      cwd: REPO_ROOT,
      env: { ...base, PATH: process.env.PATH ?? '' },
      encoding: 'utf8',
    });
    return { status: 0, stdout, stderr: '' };
  } catch (error) {
    const failure = error as { status?: number; stdout?: string; stderr?: string };
    return {
      status: failure.status ?? -1,
      stdout: failure.stdout ?? '',
      stderr: failure.stderr ?? '',
    };
  }
}

describe('Cloudflare credential preflight', () => {
  it('exists and is executable, so the workflow step can invoke it directly', () => {
    expect(fs.existsSync(SCRIPT)).toBe(true);
    const mode = fs.statSync(SCRIPT).mode;
    // Owner execute bit: `bash script.sh` tolerates a missing bit, but the step
    // is documented as runnable directly and CI runs on umask-sensitive images.
    expect(mode & 0o100).toBeTruthy();
  });

  it('refuses to pass when both credentials are absent', () => {
    const result = runPreflight({
      // Explicitly unset: inherited PATH keeps the shell usable, nothing else.
      CLOUDFLARE_API_TOKEN: undefined,
      CLOUDFLARE_ACCOUNT_ID: undefined,
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('CLOUDFLARE_API_TOKEN');
    expect(result.stderr).toContain('CLOUDFLARE_ACCOUNT_ID');
    expect(result.stdout).not.toContain('CLOUDFLARE_CREDENTIALS_AVAILABLE');
  });

  it('names only the credential that is actually missing', () => {
    // A message listing both would send an operator looking for a secret that
    // is already configured.
    const result = runPreflight({
      CLOUDFLARE_API_TOKEN: 'present',
      CLOUDFLARE_ACCOUNT_ID: undefined,
    });
    expect(result.status).toBe(1);
    expect(result.stderr.split('\n')[0]).toBe(
      'FATAL: 1 Cloudflare credential(s) are not available in this job: CLOUDFLARE_ACCOUNT_ID'
    );
  });

  it('reports the secret names the workflow must use, not only the variable names', () => {
    // The whole defect was a secret/variable conflation; the fix message has to
    // name the secret so the next person does not repeat it.
    const result = runPreflight({
      CLOUDFLARE_API_TOKEN: undefined,
      CLOUDFLARE_ACCOUNT_ID: undefined,
    });
    expect(result.stderr).toContain('secrets.CLOUDFLARE_API_TOKEN');
    expect(result.stderr).toContain('secrets.CLOUDFLARE_ACCOUNT_ID');
  });

  it('passes when both credentials are present', () => {
    const result = runPreflight({
      CLOUDFLARE_API_TOKEN: 'present',
      CLOUDFLARE_ACCOUNT_ID: 'present',
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('CLOUDFLARE_CREDENTIALS_AVAILABLE');
  });
});

describe('deploy workflow secret names', () => {
  const workflow = fs.readFileSync(WORKFLOW, 'utf8');

  it('reads no secret name outside the Cloudflare credential pair', () => {
    // The register of secret names the workflow is allowed to depend on. Adding
    // one is fine; a typo in the existing pair is not, and the grep below is
    // what catches it.
    const referenced = [
      ...workflow.matchAll(/secrets\.([A-Za-z0-9_]+)/g),
    ].map((match) => match[1]);

    expect(referenced.length).toBeGreaterThan(0);
    expect([...new Set(referenced)].sort()).toEqual([
      'CLOUDFLARE_ACCOUNT_ID',
      'CLOUDFLARE_API_TOKEN',
    ]);
  });

  it('never maps a credential secret onto the wrong variable', () => {
    // The original defect was `CLOUDFLARE_API_TOKEN: ${{ secrets.CF_API_TOKEN }}`.
    // Both lines looked individually reasonable, so assert the pairing.
    expect(workflow).not.toMatch(/CLOUDFLARE_API_TOKEN:\s*\$\{\{\s*secrets\.(?!CLOUDFLARE_API_TOKEN)/);
    expect(workflow).not.toMatch(/CLOUDFLARE_ACCOUNT_ID:\s*\$\{\{\s*secrets\.(?!CLOUDFLARE_ACCOUNT_ID)/);
  });

  it('registers the preflight in every job that calls Cloudflare', () => {
    // The rollback job reads the same credential pair, so it needs the same gate.
    const count = workflow.match(/scripts\/assert-cloudflare-credentials\.sh/g)?.length ?? 0;
    expect(count).toBeGreaterThanOrEqual(3);
  });

  it('asserts the credentials before each job spends anything on them', () => {
    // A preflight placed after the deploy step is decoration. Asserted per job:
    // `indexOf` on the whole file only finds the first occurrence, which is in
    // deploy-staging, and would blind the test to a preflight moved to the end
    // of deploy-production or rollback.
    const jobs = [
      {
        name: 'deploy-staging',
        start: workflow.indexOf('deploy-staging:'),
        spends: [
          'Install dependencies',
          'Deploy to Cloudflare Workers (Staging)',
        ],
      },
      {
        name: 'deploy-production',
        start: workflow.indexOf('deploy-production:'),
        spends: [
          'Install dependencies',
          'Enforce strict economic go-live verdict',
          'Deploy to Cloudflare Workers (Production)',
        ],
      },
      {
        name: 'rollback',
        start: workflow.indexOf('rollback:'),
        spends: ['Install dependencies', 'Execute rollback'],
      },
    ];

    for (const job of jobs) {
      if (job.start === -1) {
        throw new Error('missing job block in deploy.yml: ' + job.name);
      }
      // A job runs to the next top-level job key, so slice on that boundary
      // rather than on a nested `if:` literal line.
      const end = workflow.slice(job.start).search(/\n  [a-z][a-z0-9-]*:/);
      const body = end === -1
        ? workflow.slice(job.start)
        : workflow.slice(job.start, job.start + end);

      const preflight = body.indexOf('scripts/assert-cloudflare-credentials.sh');
      if (preflight === -1) {
        throw new Error('job ' + job.name + ' registers no preflight');
      }

      for (const spends of job.spends) {
        const at = body.indexOf(spends);
        if (at === -1) {
          throw new Error(job.name + ' is missing step: ' + spends);
        }
        if (preflight > at) {
          throw new Error(job.name + ': preflight must precede ' + spends);
        }
      }
    }
  });
});
