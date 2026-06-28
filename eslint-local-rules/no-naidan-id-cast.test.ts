import { describe, it, expect, beforeAll } from 'vitest';
import { ESLint } from 'eslint';
import path from 'path';
import * as parser from '@typescript-eslint/parser';
import { rule } from './no-naidan-id-cast.js';

describe('no-naidan-id-cast rule', () => {
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
          'local-rules-naidan-id-cast': {
            rules: {
              'no-naidan-id-cast': rule,
            },
          },
        },
        rules: {
          'local-rules-naidan-id-cast/no-naidan-id-cast': 'error',
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

  it('reports direct assertions to a Naidan ID type outside ids.ts', async () => {
    const messages = await lintText({
      code: `import type { ChatId } from '@/01-models/ids'; const chatId = raw as ChatId`,
    });

    expect(messages).toHaveLength(1);
    expect(messages[0]?.messageId).toBe('noNaidanIdCast');
  });

  it('reports angle-bracket assertions to a Naidan ID type outside ids.ts', async () => {
    const messages = await lintText({
      code: `import type { MessageId } from '@/01-models/ids'; const messageId = <MessageId>raw`,
    });

    expect(messages).toHaveLength(1);
    expect(messages[0]?.messageId).toBe('noNaidanIdCast');
  });

  it('allows branding inside ids.ts', async () => {
    const messages = await lintText({
      filePath: 'src/01-models/ids.ts',
      code: `export type ChatId = string & { readonly __brand: true }; const chatId = raw as ChatId`,
    });

    expect(messages).toHaveLength(0);
  });
});
