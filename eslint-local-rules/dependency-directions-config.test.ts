import { describe, expect, it } from 'vitest';
import { ESLint } from 'eslint';
import path from 'node:path';

const repoRoot = path.resolve(__dirname, '..');

async function lintText({ code, filePath }: { code: string; filePath: string }) {
  const eslint = new ESLint({
    cwd: repoRoot,
    overrideConfigFile: path.join(repoRoot, 'eslint.dependency-directions.config.js'),
  });
  const [result] = await eslint.lintText(code, {
    filePath: path.join(repoRoot, filePath),
  });
  return result.messages;
}

describe('dependency-direction configuration', () => {
  const rawFormatImport = `import { MAGIC } from '@/00-storage/service/hizofs/00-format/v1/format-constants';`;

  it.each([
    'src/features/debug-hizofs/logic/inspection.ts',
    'src/features/debug-opfs-encryption/logic/inspection.ts',
  ])(
    'allows the reviewed exact debug feature exception for %s',
    async (filePath) => {
      expect(await lintText({ code: rawFormatImport, filePath })).toHaveLength(0);
    },
    15_000,
  );

  it('does not grant the exception to future debug features', async () => {
    const messages = await lintText({
      code: rawFormatImport,
      filePath: 'src/features/debug-future/logic/inspection.ts',
    });
    expect(messages).toHaveLength(1);
    expect(messages[0]?.ruleId).toBe('local-rules/enforce-dependency-directions');
  });

});
