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
import { strings, stringsAsync } from '@/strings';
strings.ChatInput__type_a_message();
await stringsAsync.ChatInput__failed_to_copy({
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
import { strings as localizedStrings, strings } from '@/strings';
const key = 'ChatInput__type_a_message';
strings[key]();
const message = strings.ChatInput__type_a_message;
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
});
