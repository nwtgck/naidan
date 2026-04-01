import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { ESLint } from 'eslint';
import path from 'path';
import fs from 'fs';
import { rule } from './prefer-multiline-template-literals.js';
import ruleConfig from './prefer-multiline-template-literals.js';
import * as parser from '@typescript-eslint/parser';

describe('prefer-multiline-template-literals rule', () => {
  let eslint: ESLint;
  let eslintFix: ESLint;
  const testFileDir = path.resolve(__dirname, '../src/test-tmp');
  const testFileName = `temp-multiline-template-lint-${Math.random().toString(36).slice(2)}.fixture.ts`;
  const testFilePath = path.resolve(testFileDir, testFileName);

  beforeAll(() => {
    if (!fs.existsSync(testFileDir)) {
      fs.mkdirSync(testFileDir, { recursive: true });
    }

    const baseConfig = {
      overrideConfigFile: true,
      overrideConfig: {
        files: ['**/*.ts'],
        languageOptions: {
          parser,
        },
        plugins: {
          'local-rules-multiline-template-literals': {
            rules: {
              'prefer-multiline-template-literals': rule,
            },
          },
        },
        rules: {
          'local-rules-multiline-template-literals/prefer-multiline-template-literals': 'error',
        },
      },
    };

    eslint = new ESLint({ ...baseConfig, fix: false });
    eslintFix = new ESLint({ ...baseConfig, fix: true });
  });

  afterAll(() => {
    if (fs.existsSync(testFilePath)) {
      fs.unlinkSync(testFilePath);
    }
  });

  async function lint(code: string) {
    fs.writeFileSync(testFilePath, code);
    const results = await eslint.lintFiles([testFilePath]);
    return results[0];
  }

  async function fix(code: string) {
    fs.writeFileSync(testFilePath, code);
    const results = await eslintFix.lintFiles([testFilePath]);
    return results[0];
  }

  it('applies to ts and vue files in the exported ESLint config', () => {
    expect(ruleConfig.files).toEqual(['**/*.ts', '**/*.vue']);
  });

  it('reports escaped multiline single-quoted strings', async () => {
    const code = `\
const script = 'cat <<EOF\\nhello\\nworld\\nEOF';
`;

    const result = await lint(code);

    expect(result.messages.some((message) => message.ruleId === 'local-rules-multiline-template-literals/prefer-multiline-template-literals')).toBe(true);
  });

  it('auto-fixes escaped multiline strings to template literals', async () => {
    const code = `\
const script = "cat <<EOF\\nhello\\nworld\\nEOF";
`;

    const result = await fix(code);

    expect(result.output).toBe(`\
const script = \`\\
cat <<EOF
hello
world
EOF\`;
`);
  });

  it('reports newline-delimited JSON because it represents real multi-line content', async () => {
    const code = `\
const payload = '{"a":1}\\n{"b":2}';
`;

    const result = await lint(code);

    expect(result.messages.some((message) => message.ruleId === 'local-rules-multiline-template-literals/prefer-multiline-template-literals')).toBe(true);
  });

  it('auto-fixes newline-delimited JSON to a multiline template literal', async () => {
    const code = `\
const payload = '{"a":1}\\n{"b":2}';
`;

    const result = await fix(code);

    expect(result.output).toBe(`\
const payload = \`\\
{"a":1}
{"b":2}\`;
`);
  });

  it('does not report single-line strings with only a trailing newline escape', async () => {
    const code = `\
const stdout = 'ok\\n';
`;

    const result = await lint(code);

    expect(result.messages).toHaveLength(0);
  });

  it('does not auto-fix single-line strings with only a trailing newline escape', async () => {
    const code = `\
const stdout = 'ok\\n';
`;

    const result = await fix(code);

    expect(result.output).toBeUndefined();
  });

  it('does not report strings made only of whitespace and newline escapes', async () => {
    const code = `\
const spacer = ' \\n ';
`;

    const result = await lint(code);

    expect(result.messages).toHaveLength(0);
  });

  it('does not auto-fix strings made only of whitespace and newline escapes', async () => {
    const code = `\
const spacer = ' \\n ';
`;

    const result = await fix(code);

    expect(result.output).toBeUndefined();
  });

  it('does not report strings made only of newline escapes', async () => {
    const code = `\
const spacer = '\\n\\n';
`;

    const result = await lint(code);

    expect(result.messages).toHaveLength(0);
  });

  it('does not auto-fix strings made only of newline escapes', async () => {
    const code = `\
const spacer = '\\n\\n';
`;

    const result = await fix(code);

    expect(result.output).toBeUndefined();
  });

  it('does not report strings that also contain other escapes like tab', async () => {
    const code = `\
const text = 'hello\\n\\tworld';
`;

    const result = await lint(code);

    expect(result.messages).toHaveLength(0);
  });

  it('does not auto-fix strings that also contain other escapes like tab', async () => {
    const code = `\
const text = 'hello\\n\\tworld';
`;

    const result = await fix(code);

    expect(result.output).toBeUndefined();
  });

  it('does not report strings that contain other escapes like escaped backticks', async () => {
    const code = `\
const script = "before \\\`value\\\`\\n\${value}\\nafter";
`;

    const result = await lint(code);

    expect(result.messages).toHaveLength(0);
  });

  it('does not auto-fix strings that contain other escapes like escaped backticks', async () => {
    const code = `\
const script = "before \\\`value\\\`\\n\${value}\\nafter";
`;

    const result = await fix(code);

    expect(result.output).toBeUndefined();
  });
});
