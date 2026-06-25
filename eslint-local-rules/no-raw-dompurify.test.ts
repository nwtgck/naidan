import { describe, it, expect, beforeAll } from 'vitest';
import { ESLint } from 'eslint';
import path from 'path';
import * as parser from '@typescript-eslint/parser';
import { rule } from './no-raw-dompurify.js';

describe('no-raw-dompurify rule', () => {
  let eslint: ESLint;
  const repoRoot = path.resolve(__dirname, '..');

  beforeAll(() => {
    eslint = new ESLint({
      cwd: repoRoot,
      overrideConfigFile: true,
      overrideConfig: {
        files: ['**/*.ts'],
        languageOptions: {
          parser,
          parserOptions: {
            sourceType: 'module',
            ecmaVersion: 'latest',
          },
        },
        plugins: {
          'local-rules-raw-dompurify': {
            rules: {
              'no-raw-dompurify': rule,
            },
          },
        },
        rules: {
          'local-rules-raw-dompurify/no-raw-dompurify': 'error',
        },
      },
    });
  });

  async function lintText({
    code,
    filePath = 'src/components/Example.ts',
  }: {
    code: string,
    filePath?: string,
  }) {
    const [result] = await eslint.lintText(code, { filePath: path.resolve(repoRoot, filePath) });
    return result.messages;
  }

  it('reports DOMPurify imports outside the AllowedHtml module', async () => {
    const messages = await lintText({ code: `import DOMPurify from 'dompurify'` });

    expect(messages).toHaveLength(1);
    expect(messages[0]?.messageId).toBe('noRawDompurify');
  });

  it('allows DOMPurify imports inside allowedHtml.ts', async () => {
    const messages = await lintText({
      filePath: 'src/lib/security/allowedHtml.ts',
      code: `import DOMPurify from 'dompurify'`,
    });

    expect(messages).toHaveLength(0);
  });
});
