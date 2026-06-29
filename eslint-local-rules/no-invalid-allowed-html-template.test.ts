import { describe, it, expect, beforeAll } from 'vitest';
import { ESLint } from 'eslint';
import path from 'path';
import * as parser from '@typescript-eslint/parser';
import { rule } from './no-invalid-allowed-html-template.js';

describe('no-invalid-allowed-html-template rule', () => {
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
          'local-rules-allowed-html-template': {
            rules: {
              'no-invalid-allowed-html-template': rule,
            },
          },
        },
        rules: {
          'local-rules-allowed-html-template/no-invalid-allowed-html-template': 'error',
        },
      },
    });
  });

  async function lintText({ code }: { code: string }) {
    const [result] = await eslint.lintText(code, { filePath: path.resolve(repoRoot, 'src/components/Example.ts') });
    return result.messages;
  }

  it('allows narrow static HTML templates', async () => {
    const messages = await lintText({
      code: `import { allowedHtml } from '@/logic/security/allowedHtml'; allowedHtml\`<span class="sr-only" aria-label="x">Loading</span><br>\`;`,
    });

    expect(messages).toHaveLength(0);
  });

  it('reports direct allowedHtml calls', async () => {
    const messages = await lintText({
      code: `import { allowedHtml } from '@/logic/security/allowedHtml'; allowedHtml('<div></div>')`,
    });

    expect(messages).toHaveLength(1);
    expect(messages[0]?.messageId).toBe('directCall');
  });

  it('reports interpolations', async () => {
    const messages = await lintText({
      code: `import { allowedHtml } from '@/logic/security/allowedHtml'; allowedHtml\`<div>\${label}</div>\`;`,
    });

    expect(messages).toHaveLength(1);
    expect(messages[0]?.messageId).toBe('interpolation');
  });

  it('reports disallowed tags and attributes', async () => {
    const messages = await lintText({
      code: `import { allowedHtml } from '@/logic/security/allowedHtml'; allowedHtml\`<img src=x onerror=alert(1)>\`;`,
    });

    expect(messages.map(message => message.messageId)).toContain('invalidLiteral');
  });

  it('reports aliased allowedHtml imports', async () => {
    const messages = await lintText({
      code: `import { allowedHtml as ah } from '@/logic/security/allowedHtml'; ah\`<script>alert(1)</script>\`;`,
    });

    expect(messages).toHaveLength(1);
    expect(messages[0]?.messageId).toBe('aliasImport');
  });

  it('reports namespace imports from the AllowedHtml module', async () => {
    const messages = await lintText({
      code: `import * as allowedHtmlModule from '@/logic/security/allowedHtml'; allowedHtmlModule.allowedHtml\`<div></div>\`;`,
    });

    expect(messages).toHaveLength(1);
    expect(messages[0]?.messageId).toBe('namespaceImport');
  });
});
