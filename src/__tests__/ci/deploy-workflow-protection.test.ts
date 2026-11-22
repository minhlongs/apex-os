import fs from 'node:fs';
import path from 'node:path';

/**
 * Static regression guards for `.github/workflows/deploy.yml` and `.github/workflows/ci.yml`.
 * Ensures every production deployment or production rollback action is bound to the
 * protected `production` GitHub environment and restricted to `refs/heads/master`,
 * with zero automated deploy/migration triggers on merge or push.
 */
describe('GitHub Actions deployment & rollback environment protection', () => {
  const repoRoot = path.resolve(__dirname, '../../..');
  const deployPath = path.join(repoRoot, '.github/workflows/deploy.yml');
  const ciPath = path.join(repoRoot, '.github/workflows/ci.yml');

  const deployYaml = fs.readFileSync(deployPath, 'utf8');
  const ciYaml = fs.readFileSync(ciPath, 'utf8');

  function extractJobs(yamlText: string): Record<string, string> {
    const jobsIdx = yamlText.indexOf('\njobs:\n');
    expect(jobsIdx).toBeGreaterThan(-1);
    const jobsSection = yamlText.slice(jobsIdx + '\njobs:\n'.length);
    const matches = [...jobsSection.matchAll(/^  ([a-zA-Z0-9_-]+):\s*$/gm)];
    const result: Record<string, string> = {};
    for (let i = 0; i < matches.length; i += 1) {
      const name = matches[i][1];
      const start = matches[i].index ?? 0;
      const end = i + 1 < matches.length ? (matches[i + 1].index ?? jobsSection.length) : jobsSection.length;
      result[name] = jobsSection.slice(start, end);
    }
    return result;
  }

  test('deploy.yml triggers exclusively on manual workflow_dispatch', () => {
    const onBlock = deployYaml.split('\nconcurrency:')[0];
    expect(onBlock).toContain('workflow_dispatch:');
    expect(onBlock).not.toMatch(/^\s+push:/m);
    expect(onBlock).not.toMatch(/^\s+pull_request:/m);
    expect(onBlock).not.toMatch(/^\s+schedule:/m);
  });

  test('deploy.yml separates rollback into rollback-staging and rollback-production with no unprotected common rollback job', () => {
    const jobs = extractJobs(deployYaml);
    expect(Object.keys(jobs).sort()).toEqual([
      'deploy-production',
      'deploy-staging',
      'rollback-production',
      'rollback-staging',
    ]);
    expect(jobs.rollback).toBeUndefined();
  });

  test('every production mutation job requires environment: production and refs/heads/master', () => {
    const jobs = extractJobs(deployYaml);

    for (const prodJobName of ['deploy-production', 'rollback-production'] as const) {
      const block = jobs[prodJobName];
      expect(block).toBeDefined();
      expect(block).toMatch(/^\s{4}environment:\s*\n\s{6}name:\s*production\b/m);
      expect(block).toContain("github.ref == 'refs/heads/master'");
    }

    // Staging jobs must target staging environment and staging wrangler config only.
    for (const stagingJobName of ['deploy-staging', 'rollback-staging'] as const) {
      const block = jobs[stagingJobName];
      expect(block).toBeDefined();
      expect(block).toMatch(/^\s{4}environment:\s*\n\s{6}name:\s*staging\b/m);
      expect(block).toContain('--config wrangler.staging.jsonc');
      expect(block).not.toMatch(/wrangler\s+(deploy|rollback)\s+--config\s+wrangler\.jsonc\b/);
    }
  });

  test('no job invokes production wrangler deploy/rollback outside environment: production', () => {
    const jobs = extractJobs(deployYaml);
    for (const [jobName, block] of Object.entries(jobs)) {
      const touchesProdConfig = /wrangler\s+(deploy|rollback)\s+--config\s+wrangler\.jsonc\b/.test(block);
      if (touchesProdConfig) {
        expect(jobName).toMatch(/production$/);
        expect(block).toMatch(/^\s{4}environment:\s*\n\s{6}name:\s*production\b/m);
        expect(block).toContain("github.ref == 'refs/heads/master'");
      }
    }
  });

  test('ci.yml contains no wrangler deploy, rollback, or remote D1 mutations and preserves required check name', () => {
    expect(ciYaml).toContain('name: Typecheck, Lint, Test & Worker Bundle');
    expect(ciYaml).not.toMatch(/wrangler\s+(deploy|rollback|d1\s+migrations\s+apply)/);
  });
});
