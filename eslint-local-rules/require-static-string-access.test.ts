import { ESLint } from 'eslint';
import * as parser from '@typescript-eslint/parser';
import { describe, expect, it } from 'vitest';

import { rule } from './require-static-string-access.js';

async function lint({ code }: {
  code: string;
}) {
  const eslint = new ESLint({
    overrideConfigFile: true,
    overrideConfig: {
      files: ['**/*.ts'],
      languageOptions: {
        parser,
        parserOptions: {
          ecmaVersion: 'latest',
          sourceType: 'module',
        },
      },
      plugins: {
        'local-rules-boundary-strings': {
          rules: {
            'require-static-string-access': rule,
          },
        },
      },
      rules: {
        'local-rules-boundary-strings/require-static-string-access': 'error',
      },
    },
  });
  return eslint.lintText(code, { filePath: 'fixture.ts' });
}

describe('require-static-string-access', () => {
  it('allows direct calls with a static key', async () => {
    const [result] = await lint({
      code: `\
import { lazyStrings, ensureStrings } from '@/strings';
lazyStrings.ChatInput__type_a_message();
await ensureStrings.ChatInput__failed_to_copy({
  name: 'folder',
  errorMessage: 'failed',
});
`,
    });
    expect(result?.messages).toEqual([]);
  });

  it('rejects aliases, computed keys, and extracted methods', async () => {
    const [result] = await lint({
      code: `\
import { lazyStrings as localizedStrings, lazyStrings } from '@/strings';
const key = 'ChatInput__type_a_message';
lazyStrings[key]();
const message = lazyStrings.ChatInput__type_a_message;
localizedStrings.ChatInput__type_a_message();
`,
    });
    expect(result?.messages.map((message) => message.messageId)).toEqual([
      'noAlias',
      'directCall',
      'directCall',
      'directCall',
    ]);
  });

  it('rejects indirect, spread, and computed message argument objects', async () => {
    const [result] = await lint({
      code: `\
import { ensureStrings } from '@/strings';
const args = { name: 'folder', errorMessage: 'failed' };
await ensureStrings.ChatInput__failed_to_copy(args);
await ensureStrings.ChatInput__failed_to_copy({ ...args });
const parameterName = 'name';
await ensureStrings.ChatInput__failed_to_copy({
  [parameterName]: 'folder',
  errorMessage: 'failed',
});
`,
    });
    expect(result?.messages.map((message) => message.messageId)).toEqual([
      'directArguments',
      'directArguments',
      'directArguments',
    ]);
  });
});
