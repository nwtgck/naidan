// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { ESLint } from 'eslint';
import path from 'node:path';

const repoRoot = path.resolve(import.meta.dirname, '..');
const prefix = 'local-rules-test-command/';

function createEslint() {
  return new ESLint({ cwd: repoRoot, overrideConfigFile: path.join(repoRoot, 'eslint.config.js') });
}

describe('command policy main config integration', () => {
  it.each(['scripts/example.ts', 'eslint-local-rules/example.test.ts', 'src/runtime.ts', 'pwa/runtime.ts', 'src/View.vue', 'scripts/View.vue', 'src/runtime.mts', 'src/runtime.cts', 'src/runtime.tsx', 'src/runtime.mjs', 'src/runtime.cjs', 'docs/example.test.ts', 'build/example.test-support.ts'])('checks owned file %s', async filePath => {
    const config = await createEslint().calculateConfigForFile(filePath);
    for (const rule of ['no-unapproved-command-entry', 'require-test-command-permission']) {
      expect(config?.rules?.[`${prefix}${rule}`]?.[0]).toBe(2);
    }
  });

  it('keeps unrelated type-aware rules inactive and their directives valid', async () => {
    const results = await createEslint().lintText(`\
// eslint-disable-next-line local-rules-named-args/require-named-args
function commandFree(value) {
  return value;
}
`, { filePath: 'scripts/example.ts' });
    expect(results[0]?.messages).toEqual([]);
  });

  it('enforces raw execution and permission checks through the actual main config', async () => {
    const raw = await createEslint().lintText("import { spawn } from 'node:child_process';", { filePath: 'scripts/example.ts' });
    expect(raw[0]?.messages.map(message => message.messageId)).toContain('rawCommandEntry');
    const unapproved = await createEslint().lintText(`\
import { runCommand } from '../build/command';
runCommand({
  argv: ['git', 'diff'],
  options: undefined,
});
`, { filePath: 'scripts/example.ts' });
    expect(unapproved[0]?.messages.map(message => message.messageId)).toContain('missingPermission');
  });

  it.each(['dist/entry.ts', 'docs/dist/entry.ts', 'public/entry.ts', 'eslint-local-rules/fixtures/negative.test.ts', 'src/test-tmp/example.ts', 'build/transformers-js-fixes/upstream/entry.ts'])('retains global ignore for %s', async filename => {
    expect(await createEslint().isPathIgnored(filename)).toBe(true);
  });
});
