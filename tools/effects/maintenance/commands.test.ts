import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { createFixture } from '../test-support/project-fixture.ts';

const repository = path.resolve(import.meta.dirname, '../../..');

function execute({ root, script, args }: { root: string, script: string, args: readonly string[] }) {
  return spawnSync(process.execPath, ['--import', path.join(repository, 'node_modules/tsx/dist/loader.mjs'),
    path.join(repository, 'tools/effects', script), ...args], { cwd: root, encoding: 'utf8', timeout: 60_000 });
}

function configuredFixture({ files, entries, extraRules }: {
  files: Readonly<Record<string, string>>, entries: readonly string[], extraRules: Readonly<Record<string, string>>,
}) {
  const fixture = createFixture({ files, entries });
  fs.writeFileSync(path.join(fixture.root, 'effects.config.ts'), 'export default ' + JSON.stringify(fixture.config) + ';');
  // Child phases use genuine ESLint, typed parser services and the production
  // effects rule. Absolute imports are fixture wiring, not product configuration.
  const url = ({ relative }: { relative: string }) => pathToFileURL(path.join(repository, relative)).href;
  fs.writeFileSync(path.join(fixture.root, 'eslint.config.mjs'), `import parser from ${JSON.stringify(url({ relative: 'node_modules/@typescript-eslint/parser/dist/index.js' }))};
import { tsImport } from ${JSON.stringify(url({ relative: 'node_modules/tsx/dist/esm/api/index.mjs' }))};
const { createEffectsRule } = await tsImport(${JSON.stringify(path.join(repository, 'eslint-local-rules/effects.ts'))}, import.meta.url);
const config = ${JSON.stringify(fixture.config)};
export default [{
  files: ['**/*.ts'],
  languageOptions: { parser, parserOptions: { project: './tsconfig.json', tsconfigRootDir: import.meta.dirname } },
  plugins: { 'local-effects': { rules: { contracts: createEffectsRule({ root: import.meta.dirname, config }) } } },
  rules: { 'local-effects/contracts': 'error', ...${JSON.stringify(extraRules)} },
}];
`);
  return fixture;
}

describe('maintenance commands use the production engine', () => {
  it('defaults tidy to preview, writes only with --write, and emits no change on a second run', () => {
    const source = '/** @effects `network.http(*)` */ export function run() {}';
    const fixture = configuredFixture({ files: { 'main.ts': source }, entries: ['main.ts'], extraRules: {} });
    try {
      const preview = execute({ root: fixture.root, script: 'cli.ts', args: ['tidy', '--json'] });
      expect(preview.stderr).toBe('');
      expect(preview.status).toBe(0);
      expect(JSON.parse(preview.stdout)).toMatchObject({ changedFiles: [], tidy: { mode: 'preview', changes: [{ label: 'run', before: ['network.http(*)'], after: [] }] } });
      expect(fs.readFileSync(path.join(fixture.root, 'main.ts'), 'utf8')).toBe(source);
      const written = execute({ root: fixture.root, script: 'cli.ts', args: ['tidy', '--write', '--json'] });
      expect(written.status).toBe(0);
      expect(JSON.parse(written.stdout).changedFiles).toHaveLength(1);
      const repeated = execute({ root: fixture.root, script: 'cli.ts', args: ['tidy', '--json'] });
      expect(repeated.status).toBe(0);
      expect(JSON.parse(repeated.stdout).tidy.changes).toEqual([]);
    } finally {
      fixture.dispose();
    }
  }, 30_000);

  it('treats --file as a tidy selection, not a replacement of the validated scope', () => {
    const fixture = configuredFixture({
      files: {
        'main.ts': '/** @effects `network.http(*)` */ export function run() {}',
        'other.ts': '/** @effects `none` */ export function invalid() { fetch("/x"); }',
      },
      entries: ['main.ts', 'other.ts'],
      extraRules: {},
    });
    try {
      const result = execute({ root: fixture.root, script: 'cli.ts', args: ['tidy', '--file', 'main.ts', '--write'] });
      expect(result.status).toBe(2);
      expect(result.stderr).toContain('clean ordinary check');
      expect(fs.readFileSync(path.join(fixture.root, 'main.ts'), 'utf8')).toContain('network.http');
    } finally {
      fixture.dispose();
    }
  });

  it.each(['check', 'fix'])('rejects --write on %s without editing', mode => {
    const fixture = configuredFixture({ files: { 'main.ts': 'function run() {}' }, entries: ['main.ts'], extraRules: {} });
    try {
      const result = execute({ root: fixture.root, script: 'cli.ts', args: [mode, '--write'] });
      expect(result.status).toBe(2);
      expect(result.stderr).toContain('--write is valid only for tidy');
      expect(fs.readFileSync(path.join(fixture.root, 'main.ts'), 'utf8')).toBe('function run() {}');
    } finally {
      fixture.dispose();
    }
  });
});

describe('lint fix orchestrates separate typed analysis epochs', () => {
  it('repairs ordinary lint, widens dependency contracts, then validates with the real effects rule', () => {
    const fixture = configuredFixture({
      files: {
        'main.ts': "import { save } from './dep'; export function run() { save();; }",
        'dep.ts': 'export function save() { localStorage.clear(); }',
      },
      entries: ['main.ts'],
      extraRules: { 'no-extra-semi': 'error' },
    });
    try {
      const result = execute({ root: fixture.root, script: 'lint-fix.ts', args: ['main.ts', '--json'] });
      expect(result.stderr).toBe('');
      expect(result.status).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({
        exitCode: 0,
        stages: [{ phase: 'ordinary-fix', status: 0 }, { phase: 'validation', status: 0 }],
        effects: { status: 'checked', diagnostics: [] },
      });
      expect(JSON.parse(result.stdout).effects.changedFiles).toHaveLength(2);
      expect(fs.readFileSync(path.join(fixture.root, 'main.ts'), 'utf8')).not.toContain(';;');
      expect(fs.readFileSync(path.join(fixture.root, 'dep.ts'), 'utf8')).toContain('@effects');
      const repeat = execute({ root: fixture.root, script: 'lint-fix.ts', args: ['main.ts', '--json'] });
      expect(repeat.status).toBe(0);
      expect(JSON.parse(repeat.stdout).effects.changedFiles).toEqual([]);
    } finally {
      fixture.dispose();
    }
  }, 45_000);

  it('updates enrolled callers when only a dependency was selected for ordinary lint', () => {
    const fixture = configuredFixture({
      files: {
        'main.ts': "import { save } from './dep'; /** @effects `none` */ export function run() { save(); }",
        'dep.ts': 'export function save() { localStorage.clear(); }',
      },
      entries: ['main.ts'],
      extraRules: {},
    });
    try {
      const result = execute({ root: fixture.root, script: 'lint-fix.ts', args: ['dep.ts', '--json'] });
      expect(result.stderr).toBe('');
      expect(result.status).toBe(0);
      expect(JSON.parse(result.stdout).effects.changedFiles).toHaveLength(2);
      expect(fs.readFileSync(path.join(fixture.root, 'main.ts'), 'utf8')).toContain('localstorage.write');
    } finally {
      fixture.dispose();
    }
  }, 20_000);

  it('does not hide ordinary unfixable errors or run the effects update after them', () => {
    const fixture = configuredFixture({
      files: {
        'main.ts': 'const unused = 1; export function run() { localStorage.clear();; }',
      },
      entries: ['main.ts'],
      extraRules: { 'no-unused-vars': 'error', 'no-extra-semi': 'error' },
    });
    try {
      const result = execute({ root: fixture.root, script: 'lint-fix.ts', args: ['main.ts', '--json'] });
      expect(result.status).toBe(1);
      expect(JSON.parse(result.stdout).stages).toHaveLength(1);
      const text = fs.readFileSync(path.join(fixture.root, 'main.ts'), 'utf8');
      expect(text).not.toContain(';;'); // Documented non-transactional ordinary fixes.
      expect(text).not.toContain('@effects');
    } finally {
      fixture.dispose();
    }
  });

  it('refuses unsupported effect boundaries rather than ignoring their exit status', () => {
    const fixture = configuredFixture({ files: { 'main.ts': 'export function run(value: unknown) { return Promise.resolve(value); }' }, entries: ['main.ts'], extraRules: {} });
    try {
      const before = fs.readFileSync(path.join(fixture.root, 'main.ts'), 'utf8');
      const result = execute({ root: fixture.root, script: 'lint-fix.ts', args: ['main.ts'] });
      expect(result.status).toBe(2);
      expect(result.stderr).toContain('Effect fix refused');
      expect(fs.readFileSync(path.join(fixture.root, 'main.ts'), 'utf8')).toBe(before);
    } finally {
      fixture.dispose();
    }
  });

  it('never runs tidy as part of lint fix', () => {
    const source = '/** @effects `network.http(*)` */ export function empty() {}';
    const fixture = configuredFixture({ files: { 'main.ts': source }, entries: ['main.ts'], extraRules: {} });
    try {
      const result = execute({ root: fixture.root, script: 'lint-fix.ts', args: ['main.ts', '--json'] });
      expect(result.status).toBe(0);
      expect(JSON.parse(result.stdout).effects.changedFiles).toEqual([]);
      expect(fs.readFileSync(path.join(fixture.root, 'main.ts'), 'utf8')).toBe(source);
    } finally {
      fixture.dispose();
    }
  }, 20_000);

  it('does not enroll unrelated product files or ordinary tests', () => {
    const fixture = configuredFixture({
      files: {
        'main.ts': '/** @effects `none` */ export function entry() {}',
        'other.ts': 'export function other() { localStorage.clear(); }',
        'ordinary.test.ts': 'function testCallback() { localStorage.clear(); }',
      },
      entries: ['main.ts', 'other.ts', 'ordinary.test.ts'],
      extraRules: {},
    });
    try {
      fixture.config.files = ['main.ts'];
      fs.writeFileSync(path.join(fixture.root, 'effects.config.ts'), 'export default ' + JSON.stringify(fixture.config) + ';');
      // ESLint can see all ordinary source via tsconfig, while only main is enrolled.
      const configFile = path.join(fixture.root, 'eslint.config.mjs');
      const configText = fs.readFileSync(configFile, 'utf8');
      fs.writeFileSync(configFile, configText.replace('"files":["main.ts","other.ts","ordinary.test.ts"]', '"files":["main.ts"]'));
      const result = execute({ root: fixture.root, script: 'lint-fix.ts', args: ['other.ts', 'ordinary.test.ts', '--json'] });
      expect(result.stderr).toBe('');
      expect(result.status).toBe(0);
      expect(JSON.parse(result.stdout).effects.status).toBe('not-relevant');
      expect(fs.readFileSync(path.join(fixture.root, 'other.ts'), 'utf8')).not.toContain('@effects');
      expect(fs.readFileSync(path.join(fixture.root, 'ordinary.test.ts'), 'utf8')).not.toContain('@effects');
    } finally {
      fixture.dispose();
    }
  }, 20_000);

  it('prints existing unsafe boundaries on successful lint fix', () => {
    const fixture = configuredFixture({
      files: {
        'main.ts': `/** @effects \`none\` */
/** @effectsUNSAFE \`localstorage.write(*)\` -- "Intentional probe boundary." */
export function probe() { localStorage.clear(); }
`,
      },
      entries: ['main.ts'],
      extraRules: {},
    });
    try {
      const result = execute({ root: fixture.root, script: 'lint-fix.ts', args: ['main.ts'] });
      expect(result.status).toBe(0);
      expect(result.stdout).toContain('UNSAFE effect suppression:');
      expect(result.stdout).toContain('Intentional probe boundary.');
    } finally {
      fixture.dispose();
    }
  }, 20_000);

  it('validates options instead of passing arbitrary flags or commands to a shell', () => {
    const fixture = configuredFixture({ files: { 'main.ts': '' }, entries: ['main.ts'], extraRules: {} });
    try {
      const result = execute({ root: fixture.root, script: 'lint-fix.ts', args: ['--max-warnings', 'NaN', 'main.ts'] });
      expect(result.status).toBe(2);
      expect(result.stderr).toContain('--max-warnings');
      expect(execute({ root: fixture.root, script: 'lint-fix.ts', args: ['--ignore-all-errors'] }).status).toBe(2);
    } finally {
      fixture.dispose();
    }
  });

  it('honors warnings as errors when requested', () => {
    const fixture = configuredFixture({ files: { 'main.ts': 'const unused = 1; export function run() {}' }, entries: ['main.ts'], extraRules: { 'no-unused-vars': 'warn' } });
    try {
      const result = execute({ root: fixture.root, script: 'lint-fix.ts', args: ['--max-warnings', '0', 'main.ts', '--json'] });
      expect(result.status).toBe(1);
      expect(JSON.parse(result.stdout).stages).toHaveLength(1);
      expect(fs.readFileSync(path.join(fixture.root, 'main.ts'), 'utf8')).not.toContain('@effects');
    } finally {
      fixture.dispose();
    }
  });
});

describe('lint fix final validation is not optional', () => {
  it('returns final lint errors introduced by new comments instead of declaring success', () => {
    const fixture = configuredFixture({ files: { 'main.ts': 'export function run() { localStorage.clear(); }' }, entries: ['main.ts'], extraRules: {} });
    const eslintConfig = path.join(fixture.root, 'eslint.config.mjs');
    const text = fs.readFileSync(eslintConfig, 'utf8');
    fs.writeFileSync(eslintConfig, text.replace("'local-effects/contracts': 'error',", "'local-effects/contracts': 'error', 'max-lines': ['error', { max: 1, skipComments: false }],"));
    try {
      const result = execute({ root: fixture.root, script: 'lint-fix.ts', args: ['main.ts', '--json'] });
      expect(result.stderr).toBe('');
      expect(result.status).toBe(1);
      const report = JSON.parse(result.stdout);
      expect(report.stages).toMatchObject([{ status: 0 }, { status: 1 }]);
      expect(report.stages[1].results[0].messages.some((message: { ruleId: string }) => message.ruleId === 'max-lines')).toBe(true);
      expect(fs.readFileSync(path.join(fixture.root, 'main.ts'), 'utf8')).toContain('@effects');
    } finally {
      fixture.dispose();
    }
  }, 20_000);
});
