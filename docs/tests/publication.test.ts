import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { z } from 'zod';
import { describe, expect, it } from 'vitest';

const stepSchema = z.object({
  name: z.string().optional(),
  uses: z.string().optional(),
  run: z.string().optional(),
  with: z.record(z.string(), z.unknown()).optional(),
});
const workflowSchema = z.object({
  jobs: z.record(z.string(), z.object({
    needs: z.union([z.string(), z.array(z.string())]).optional(),
    if: z.string().optional(),
    steps: z.array(stepSchema).optional(),
  })),
});
const raw: unknown = parse(readFileSync(new URL('../../.github/workflows/main.yml', import.meta.url), 'utf8'));
const workflow = workflowSchema.parse(raw);

describe('Docs publication boundaries', () => {
  it('builds Docs in an independent job with its own checks and artifact', () => {
    const job = workflow.jobs.build_docs;
    expect(job?.needs).toBeUndefined();
    expect(job?.steps?.some(step => step.run === 'npm run typecheck:docs')).toBe(true);
    expect(job?.steps?.some(step => step.run === 'npm run test:docs')).toBe(true);
    expect(job?.steps?.some(step => step.run === 'npm run build:docs')).toBe(true);
    expect(job?.steps?.find(step => step.uses?.startsWith('actions/upload-artifact'))?.with).toMatchObject({ name: 'docs-dist', path: 'docs/dist/' });
  });

  it.each(['publish_to_cloudflare', 'publish_to_cloudflare_local_only', 'publish_to_cloudflare_curated'])('merges Docs only inside successful deployment job %s', name => {
    const job = workflow.jobs[name];
    expect(job?.needs).toEqual(['build', 'build_docs']);
    expect(job?.if).toContain("needs.build.result == 'success'");
    expect(job?.if).toContain("needs.build_docs.result == 'success'");
    expect(job?.steps?.find(step => step.name === 'Download Docs-only artifact')?.with).toMatchObject({ name: 'docs-dist', path: 'docs-dist' });
    const copyIndex = job?.steps?.findIndex(step => step.run?.includes('cp -a docs-dist/. dist/hosted/docs/')) ?? -1;
    const publishIndex = job?.steps?.findIndex(step => step.uses?.startsWith('cloudflare/wrangler-action')) ?? -1;
    expect(copyIndex).toBeGreaterThan(-1);
    expect(publishIndex).toBeGreaterThan(copyIndex);
    expect(job?.steps?.some(step => step.uses?.startsWith('actions/upload-artifact'))).toBe(false);
  });

  it('keeps application build/release artifacts independent of Docs', () => {
    for (const name of ['build', 'release_to_github']) {
      const job = workflow.jobs[name];
      expect(job?.steps?.some(step => step.run?.includes('docs-dist'))).toBe(false);
      expect(job?.steps?.some(step => step.run?.includes('build:docs'))).toBe(false);
    }
    expect(workflow.jobs.release_to_github?.needs).toBe('build');
    const packageSchema = z.object({ scripts: z.record(z.string(), z.string()) });
    const value: unknown = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
    const scripts = packageSchema.parse(value).scripts;
    expect(scripts.dev).toBe('vite');
    expect(scripts.build).not.toContain('docs');
    expect(scripts['build:all']).not.toContain('docs');
    expect(scripts['build:docs']).toBe('vite build --config docs/vite.config.ts');
    expect(scripts['dev:docs']).toBeUndefined();
  });
});
