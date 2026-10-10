import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { createFixture } from './test-support/project-fixture.ts';
import { DEFAULT_EFFECT_DEFINITIONS } from './models/registry.ts';
import { parseEffectsConfig } from './config-schema.ts';

const repository = path.resolve(import.meta.dirname, '../..');

function run({ root, args }: { root: string, args: readonly string[] }) {
  return spawnSync(process.execPath, ['--import', path.join(repository, 'node_modules/tsx/dist/loader.mjs'), path.join(repository, 'tools/effects/cli.ts'), ...args], { cwd: root, encoding: 'utf8', timeout: 30_000 });
}

function writeConfig({ root, files }: { root: string, files: readonly string[] }) {
  fs.writeFileSync(path.join(root, 'effects.config.ts'), 'export default ' + JSON.stringify({ files, tsconfig: 'tsconfig.json', definitions: DEFAULT_EFFECT_DEFINITIONS, models: [], workerTransports: [], vueModels: [], analysisBudget: 100_000 }) + ';');
}

describe('effects command boundary', () => {
  // Three cold TypeScript/tsx processes are an integration check, not a 5-second benchmark.
  it('checks, fixes and rechecks in independent processes with stable exit codes', () => {
    const fixture = createFixture({ files: { 'main.ts': 'function save() { localStorage.clear(); }' }, entries: ['main.ts'] });
    try {
      writeConfig({ root: fixture.root, files: ['main.ts'] });
      const before = run({ root: fixture.root, args: ['check', '--json'] });
      expect(before.stderr).toBe('');
      expect(before.status).toBe(1);
      const fixed = run({ root: fixture.root, args: ['fix'] });
      expect(fixed.stderr).toBe('');
      expect(fixed.status).toBe(0);
      expect(fixed.stdout).toContain('1 changed files');
      const again = run({ root: fixture.root, args: ['fix'] });
      expect(again.status).toBe(0);
      expect(again.stdout).toContain('0 changed files');
    } finally {
      fixture.dispose();
    }
  }, 15_000);

  it('does not write if ordinary TypeScript rejects the source', () => {
    const source = 'const value: string = 3; function save() { localStorage.clear(); }';
    const fixture = createFixture({ files: { 'main.ts': source }, entries: ['main.ts'] });
    try {
      writeConfig({ root: fixture.root, files: ['main.ts'] });
      const result = run({ root: fixture.root, args: ['fix'] });
      expect(result.status).toBe(2);
      expect(result.stderr).toContain('Effect fix refused');
      expect(fs.readFileSync(path.join(fixture.root, 'main.ts'), 'utf8')).toBe(source);
    } finally {
      fixture.dispose();
    }
  });

  it('reports malformed invocation without creating configuration files', () => {
    const fixture = createFixture({ files: { 'main.ts': '' }, entries: ['main.ts'] });
    try {
      const result = run({ root: fixture.root, args: ['--typo'] });
      expect(result.status).toBe(2);
      expect(fs.existsSync(path.join(fixture.root, 'effects.config.ts'))).toBe(false);
    } finally {
      fixture.dispose();
    }
  });

  it('does not widen the rollout by parsing unrelated tsconfig include files', () => {
    const fixture = createFixture({ files: { 'main.ts': '/** @effects `none` */ function inspect() {}', 'outside.ts': 'function outside() { localStorage.clear(); }' }, entries: ['main.ts', 'outside.ts'] });
    try {
      writeConfig({ root: fixture.root, files: ['main.ts'] });
      const result = run({ root: fixture.root, args: ['check'] });
      expect(result.status).toBe(0);
      expect(result.stdout).toContain('1 selected files');
    } finally {
      fixture.dispose();
    }
  });

  it('validates executable configuration data with a strict schema', () => {
    expect(() => parseEffectsConfig({ value: { files: [] } })).toThrow();
    const valid = { files: ['main.ts'], tsconfig: 'tsconfig.json', definitions: DEFAULT_EFFECT_DEFINITIONS, models: [], workerTransports: [], vueModels: [], analysisBudget: 100 };
    expect(() => parseEffectsConfig({ value: { ...valid, unrecognized: true } })).toThrow();
    expect(parseEffectsConfig({ value: { ...valid, models: [{ file: 'environment.d.ts', export: 'FLAG', effects: [], returnValue: 'scalar-value', sha256: 'a'.repeat(64) }] } }).models[0]?.returnValue).toBe('scalar-value');
    expect(() => parseEffectsConfig({ value: { ...valid, models: [{ file: 'environment.d.ts', export: 'FLAG', effects: ['network.http(*)'], returnValue: 'scalar-value', sha256: 'a'.repeat(64) }] } })).toThrow('scalar-value');
    expect(() => parseEffectsConfig({ value: { ...valid, vueModels: [{ file: 'vue.d.ts', sha256: 'not-a-digest' }] } })).toThrow();
    expect(() => parseEffectsConfig({ value: { ...valid, definitions: [...DEFAULT_EFFECT_DEFINITIONS, { name: 'none', arguments: 'none' }] } })).toThrow('reserved');
  });
});

describe('unsafe effect exceptions stay visible at the command boundary', () => {
  const source = `\
/** @effects \`none\` */
/** @effectsUNSAFE \`localstorage.write(*)\` -- "Reviewed CLI probe." */
function probe() { localStorage.clear(); }
/** @effects \`none\` */ function caller() { probe(); }
`;

  it('prints the explicit exception even for a successful check', () => {
    const fixture = createFixture({ files: { 'main.ts': source }, entries: ['main.ts'] });
    try {
      writeConfig({ root: fixture.root, files: ['main.ts'] });
      const result = run({ root: fixture.root, args: ['check'] });
      expect(result.status).toBe(0);
      expect(result.stderr).toBe('');
      expect(result.stdout).toContain('UNSAFE effect suppression: main.ts:');
      expect(result.stdout).toContain('Reviewed CLI probe.');
      expect(result.stdout).toContain('1 unsafe suppressions');
    } finally {
      fixture.dispose();
    }
  });

  it('includes specified, observed and outward effects in machine-readable output', () => {
    const fixture = createFixture({ files: { 'main.ts': source }, entries: ['main.ts'] });
    try {
      writeConfig({ root: fixture.root, files: ['main.ts'] });
      const result = run({ root: fixture.root, args: ['check', '--json'] });
      expect(result.status).toBe(0);
      const report: unknown = JSON.parse(result.stdout);
      expect(report).toMatchObject({
        diagnostics: [],
        unsafeSuppressions: [{
          file: 'main.ts',
          label: 'probe',
          reason: 'Reviewed CLI probe.',
          specified: ['localstorage.write(*)'],
          body: ['localstorage.write(*)'],
          suppressed: ['localstorage.write(*)'],
          outward: [],
        }],
      });
    } finally {
      fixture.dispose();
    }
  });

  it('does not silently accept a removed probe implementation with a stale exception', () => {
    const fixture = createFixture({ files: { 'main.ts': source.replace('localStorage.clear();', '') }, entries: ['main.ts'] });
    try {
      writeConfig({ root: fixture.root, files: ['main.ts'] });
      expect(run({ root: fixture.root, args: ['check'] }).status).toBe(1);
      expect(run({ root: fixture.root, args: ['fix'] }).status).toBe(2);
    } finally {
      fixture.dispose();
    }
  });
});

describe('optional contract review', () => {
  const source = '/** @effects `indexeddb.read(*)` */ function inspect() { indexedDB.databases(); }';

  it('prints operation witnesses for already-valid contracts without editing', () => {
    const fixture = createFixture({ files: { 'main.ts': source }, entries: ['main.ts'] });
    try {
      writeConfig({ root: fixture.root, files: ['main.ts'] });
      const result = run({ root: fixture.root, args: ['check', '--explain'] });
      expect(result.status).toBe(0);
      expect(result.stdout).toContain('dependency witnesses, not runtime traces');
      expect(result.stdout).toContain('Modeled operation: indexedDB.databases');
      expect(result.stdout).toContain('[modeled-operation]');
      expect(fs.readFileSync(path.join(fixture.root, 'main.ts'), 'utf8')).toBe(source);
    } finally {
      fixture.dispose();
    }
  });

  it('emits structured review only on request and preserves the diagnostic exit code', () => {
    const fixture = createFixture({ files: { 'main.ts': 'function save() { localStorage.clear(); }' }, entries: ['main.ts'] });
    try {
      writeConfig({ root: fixture.root, files: ['main.ts'] });
      const plain = run({ root: fixture.root, args: ['check', '--json'] });
      const plainReport: unknown = JSON.parse(plain.stdout);
      expect(plainReport).not.toHaveProperty('review');
      const explained = run({ root: fixture.root, args: ['check', '--json', '--explain'] });
      const report: unknown = JSON.parse(explained.stdout);
      expect(explained.status).toBe(plain.status);
      expect(explained.status).toBe(1);
      expect(report).toHaveProperty('review');
      expect(explained.stdout).toContain('Modeled operation: localStorage.clear');
    } finally {
      fixture.dispose();
    }
  });
});

describe('primitive rationale review', () => {
  it('prints intentional-none without calling it an unsafe suppression', () => {
    const source = '/** @effects `none` */ function inspect() { navigator.storage.persisted(); navigator.storage.persist(); }';
    const fixture = createFixture({ files: { 'main.ts': source }, entries: ['main.ts'] });
    try {
      writeConfig({ root: fixture.root, files: ['main.ts'] });
      const result = run({ root: fixture.root, args: ['check', '--explain'] });
      expect(result.status).toBe(0);
      expect(result.stderr).toBe('');
      expect(result.stdout).toContain('Selected primitive policies');
      expect(result.stdout).toContain('[call, intentional-none] => none');
      expect(result.stdout).toContain('storage-manager.persisted');
      expect(result.stdout).toContain('storage-manager.ts');
      expect(result.stdout).toContain('0 unsafe suppressions');
      expect(fs.readFileSync(path.join(fixture.root, 'main.ts'), 'utf8')).toBe(source);
    } finally {
      fixture.dispose();
    }
  });

  it('includes zero-effect policy decisions with locations in opt-in JSON', () => {
    const fixture = createFixture({ files: { 'main.ts': '/** @effects `none` */ function inspect() { navigator.storage.estimate(); }' }, entries: ['main.ts'] });
    try {
      writeConfig({ root: fixture.root, files: ['main.ts'] });
      const result = run({ root: fixture.root, args: ['check', '--explain', '--json'] });
      expect(result.status).toBe(0);
      const report: unknown = JSON.parse(result.stdout);
      expect(report).toMatchObject({
        diagnostics: [],
        unsafeSuppressions: [],
        modelDecisions: [{
          file: 'main.ts',
          start: expect.any(Number),
          length: expect.any(Number),
          rule: 'storage-manager.estimate',
          operation: 'navigator.storage.estimate',
          disposition: 'intentional-none',
          reason: expect.any(String),
          effects: [],
          definitionFile: expect.stringContaining('models/browser/storage-manager.ts'),
        }],
      });
    } finally {
      fixture.dispose();
    }
  });
});
