import { describe, it, expect, beforeAll } from 'vitest';
import { ESLint } from 'eslint';
import path from 'path';
import * as parser from '@typescript-eslint/parser';
import { rule } from './no-allowed-html-cast.js';

describe('no-allowed-html-cast rule', () => {
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
          'local-rules-allowed-html-cast': {
            rules: {
              'no-allowed-html-cast': rule,
            },
          },
        },
        rules: {
          'local-rules-allowed-html-cast/no-allowed-html-cast': 'error',
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

  it('reports as AllowedHtml outside the security module', async () => {
    const messages = await lintText({
      code: `import type { AllowedHtml } from '@/logic/security/allowedHtml'; const html = raw as AllowedHtml`,
    });

    expect(messages).toHaveLength(1);
    expect(messages[0]?.messageId).toBe('noAllowedHtmlCast');
  });

  it('reports angle-bracket AllowedHtml assertions outside the security module', async () => {
    const messages = await lintText({
      code: `import type { AllowedHtml } from '@/logic/security/allowedHtml'; const html = <AllowedHtml>raw`,
    });

    expect(messages).toHaveLength(1);
    expect(messages[0]?.messageId).toBe('noAllowedHtmlCast');
  });

  it('allows branding inside allowedHtml.ts', async () => {
    const messages = await lintText({
      filePath: 'src/logic/security/allowedHtml.ts',
      code: `export type AllowedHtml = string & { readonly __brand: true }; const html = raw as AllowedHtml`,
    });

    expect(messages).toHaveLength(0);
  });
});
