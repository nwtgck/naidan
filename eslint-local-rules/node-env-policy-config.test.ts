// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { ESLint } from 'eslint';
import path from 'node:path';

const repoRoot = path.resolve(import.meta.dirname, '..');
const ruleId = 'local-rules-node-env/node-env-policy';

function createEslint() {
  return new ESLint({ cwd: repoRoot, overrideConfigFile: path.join(repoRoot, 'eslint.config.js') });
}

describe('node environment policy main configuration', () => {
  it.each(['vite.config.ts', 'build/node-env.ts', 'build/task.ts', 'build/task.test.ts', 'src/runtime.ts', 'src/runtime.test.ts', 'src/View.vue', 'scripts/tool.ts', 'scripts/tool.mts', 'scripts/tool.cts', 'scripts/tool.js', 'scripts/tool.mjs', 'scripts/tool.cjs', 'scripts/View.vue', 'eslint-local-rules/example.test.ts', 'pwa/worker.ts', 'docs/view.ts', 'docs/View.vue', 'src/runtime.tsx', 'src/runtime.jsx'])('enforces the policy for %s', async filename => {
    const config = await createEslint().calculateConfigForFile(filename);
    expect(config?.rules?.[ruleId]?.[0]).toBe(2);
  });

  it.each(['scripts/example.ts', 'scripts/example.mjs', 'eslint-local-rules/example.test.ts'])('rejects direct reading and writing through the real configuration: %s', async filename => {
    const eslint = createEslint();
    for (const code of ['process.env.X;', 'process.env.X = "x";', 'delete process.env.X;', "const p = process; p['env'].X;"]) {
      const results = await eslint.lintText(code, { filePath: filename });
      expect(results[0]?.messages.some(message => message.ruleId === ruleId)).toBe(true);
      expect(results[0]?.messages.filter(message => message.fatal)).toEqual([]);
    }
  });

  it('visits Vue templates through the main configuration', async () => {
    const results = await createEslint().lintText('<template>{{ process.env.X }}</template>', { filePath: 'scripts/View.vue' });
    expect(results[0]?.messages.some(message => message.ruleId === ruleId)).toBe(true);
  });

  it('permits Vitest stubs and virtual process maps in a test', async () => {
    const results = await createEslint().lintText(`
import { vi } from 'vitest';
vi.stubEnv('TZ', 'UTC');
vi.unstubAllEnvs();
const processes = [{ env: new Map() }];
processes.map(process => process.env.get('USER'));
`, { filePath: 'eslint-local-rules/example.test.ts' });
    expect(results[0]?.messages.filter(message => message.ruleId === ruleId || message.fatal)).toEqual([]);
  });

  it('keeps compact registry layout without weakening its environment policy', async () => {
    const registry = await createEslint().calculateConfigForFile('build/node-env.ts');
    const ordinary = await createEslint().calculateConfigForFile('build/app-source-environment.ts');
    expect(registry?.rules?.['local-rules-function-spacing/function-spacing']?.[0]).toBe(0);
    expect(ordinary?.rules?.['local-rules-function-spacing/function-spacing']?.[0]).toBe(2);
    expect(registry?.rules?.[ruleId]?.[0]).toBe(2);
  });

  it.each(['node_modules/example/index.ts', 'dist/entry.ts', 'docs/dist/entry.ts', 'public/entry.ts', 'eslint-local-rules/fixtures/negative.test.ts', 'src/test-tmp/example.ts', 'build/transformers-js-fixes/upstream/entry.ts'])('retains the existing generated/dependency exclusions: %s', async filename => {
    expect(await createEslint().isPathIgnored(filename)).toBe(true);
  });
});
