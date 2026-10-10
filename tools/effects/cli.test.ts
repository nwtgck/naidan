import fs from 'node:fs';
import path from 'node:path';
import { executeEffectsCommand } from './cli.ts';
import { describe, expect, it } from 'vitest';
import { createFixture } from './test-support/project-fixture.ts';
import { DEFAULT_EFFECT_DEFINITIONS } from './models/registry.ts';
import { parseEffectsConfig } from './config-schema.ts';

function writeConfig({ root, files }: { root: string, files: readonly string[] }) {
  fs.writeFileSync(path.join(root, 'effects.config.ts'), 'export default ' + JSON.stringify({ files, tsconfig: 'tsconfig.json', definitions: DEFAULT_EFFECT_DEFINITIONS, models: [], workerTransports: [], vueModels: [], analysisBudget: 100_000 }) + ';');
}

describe('effects command boundary', () => {
  // Three TypeScript analysis passes exercise independent command invocations.
  it('checks, fixes and rechecks with stable command exit codes', async () => {
    const fixture = createFixture({ files: { 'main.ts': 'function save() { localStorage.clear(); }' }, entries: ['main.ts'] });
    try {
      writeConfig({ root: fixture.root, files: ['main.ts'] });
      const before = await executeEffectsCommand({ root: fixture.root, argv: ['check', '--json'] });
      expect(before.stderr).toBe('');
      expect(before.exitCode).toBe(1);
      const fixed = await executeEffectsCommand({ root: fixture.root, argv: ['fix'] });
      expect(fixed.stderr).toBe('');
      expect(fixed.exitCode).toBe(0);
      expect(fixed.stdout).toContain('1 changed files');
      expect(fixed.stdout.endsWith('\n')).toBe(true);
      const again = await executeEffectsCommand({ root: fixture.root, argv: ['fix'] });
      expect(again.exitCode).toBe(0);
      expect(again.stdout).toContain('0 changed files');
    } finally {
      fixture.dispose();
    }
  }, 15_000);

  it('does not write if ordinary TypeScript rejects the source', async () => {
    const source = 'const value: string = 3; function save() { localStorage.clear(); }';
    const fixture = createFixture({ files: { 'main.ts': source }, entries: ['main.ts'] });
    try {
      writeConfig({ root: fixture.root, files: ['main.ts'] });
      const result = await executeEffectsCommand({ root: fixture.root, argv: ['fix'] });
      expect(result.exitCode).toBe(2);
      expect(result.stderr).toContain('Effect fix refused');
      expect(fs.readFileSync(path.join(fixture.root, 'main.ts'), 'utf8')).toBe(source);
    } finally {
      fixture.dispose();
    }
  });

  it('reports malformed invocation without creating configuration files', async () => {
    const fixture = createFixture({ files: { 'main.ts': '' }, entries: ['main.ts'] });
    try {
      const result = await executeEffectsCommand({ root: fixture.root, argv: ['--typo'] });
      expect(result.exitCode).toBe(2);
      expect(result.stdout).toBe('');
      expect(result.stderr).toContain("Unknown option '--typo'");
      expect(result.stderr.endsWith('\n')).toBe(true);
      expect(fs.existsSync(path.join(fixture.root, 'effects.config.ts'))).toBe(false);
    } finally {
      fixture.dispose();
    }
  });

  it('does not widen the rollout by parsing unrelated tsconfig include files', async () => {
    const fixture = createFixture({ files: { 'main.ts': '/** @effects [] */ function inspect() {}', 'outside.ts': 'function outside() { localStorage.clear(); }' }, entries: ['main.ts', 'outside.ts'] });
    try {
      writeConfig({ root: fixture.root, files: ['main.ts'] });
      const result = await executeEffectsCommand({ root: fixture.root, argv: ['check'] });
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('1 selected files');
    } finally {
      fixture.dispose();
    }
  });

  it('validates executable configuration data with a strict schema', async () => {
    expect(() => parseEffectsConfig({ value: { files: [] } })).toThrow();
    const valid = { files: ['main.ts'], tsconfig: 'tsconfig.json', definitions: DEFAULT_EFFECT_DEFINITIONS, models: [], workerTransports: [], vueModels: [], analysisBudget: 100 };
    expect(() => parseEffectsConfig({ value: { ...valid, unrecognized: true } })).toThrow();
    expect(parseEffectsConfig({ value: { ...valid, models: [{ file: 'environment.d.ts', export: 'FLAG', effects: [], returnValue: 'scalar-value', sha256: 'a'.repeat(64) }] } }).models[0]?.returnValue).toBe('scalar-value');
    expect(() => parseEffectsConfig({ value: { ...valid, models: [{ file: 'environment.d.ts', export: 'FLAG', effects: ['network.http(*)'], returnValue: 'scalar-value', sha256: 'a'.repeat(64) }] } })).toThrow('scalar-value');
    expect(() => parseEffectsConfig({ value: { ...valid, vueModels: [{ file: 'vue.d.ts', sha256: 'not-a-digest' }] } })).toThrow();
    expect(() => parseEffectsConfig({ value: { ...valid, definitions: [...DEFAULT_EFFECT_DEFINITIONS, { name: 'none', arguments: 'none' }] } })).toThrow('reserved');
    for (const effect of ['none', '`network.http(*)`', 'network.http(*), opfs.read(*)', 'network.http(*) & opfs.read(*)']) {
      expect(() => parseEffectsConfig({ value: { ...valid, models: [{ file: 'environment.d.ts', export: 'send', effects: [effect], returnValue: 'scalar', sha256: 'a'.repeat(64) }] } })).toThrow();
    }
  });
});

describe('unsafe effect exceptions stay visible at the command boundary', () => {
  const source = `\
/** @effects [] */
/** @effectsUNSAFE {"effects":["localstorage.write(*)"],"reason":"Reviewed CLI probe."} */
function probe() { localStorage.clear(); }
/** @effects [] */ function caller() { probe(); }
`;

  it('prints the explicit exception even for a successful check', async () => {
    const fixture = createFixture({ files: { 'main.ts': source }, entries: ['main.ts'] });
    try {
      writeConfig({ root: fixture.root, files: ['main.ts'] });
      const result = await executeEffectsCommand({ root: fixture.root, argv: ['check'] });
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe('');
      expect(result.stdout).toContain('UNSAFE effect suppression: main.ts:');
      expect(result.stdout).toContain('Reviewed CLI probe.');
      expect(result.stdout).toContain('1 unsafe suppressions');
    } finally {
      fixture.dispose();
    }
  });

  it('includes specified, observed and outward effects in machine-readable output', async () => {
    const fixture = createFixture({ files: { 'main.ts': source }, entries: ['main.ts'] });
    try {
      writeConfig({ root: fixture.root, files: ['main.ts'] });
      const result = await executeEffectsCommand({ root: fixture.root, argv: ['check', '--json'] });
      expect(result.exitCode).toBe(0);
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

  it('does not silently accept a removed probe implementation with a stale exception', async () => {
    const fixture = createFixture({ files: { 'main.ts': source.replace('localStorage.clear();', '') }, entries: ['main.ts'] });
    try {
      writeConfig({ root: fixture.root, files: ['main.ts'] });
      expect((await executeEffectsCommand({ root: fixture.root, argv: ['check'] })).exitCode).toBe(1);
      expect((await executeEffectsCommand({ root: fixture.root, argv: ['fix'] })).exitCode).toBe(2);
    } finally {
      fixture.dispose();
    }
  });
});

describe('optional contract review', () => {
  const source = '/** @effects ["indexeddb.read(*)"] */ function inspect() { indexedDB.databases(); }';

  it('prints operation witnesses for already-valid contracts without editing', async () => {
    const fixture = createFixture({ files: { 'main.ts': source }, entries: ['main.ts'] });
    try {
      writeConfig({ root: fixture.root, files: ['main.ts'] });
      const result = await executeEffectsCommand({ root: fixture.root, argv: ['check', '--explain'] });
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('dependency witnesses, not runtime traces');
      expect(result.stdout).toContain('Modeled operation: indexedDB.databases');
      expect(result.stdout).toContain('[modeled-operation]');
      expect(fs.readFileSync(path.join(fixture.root, 'main.ts'), 'utf8')).toBe(source);
    } finally {
      fixture.dispose();
    }
  });

  it('emits structured review only on request and preserves the diagnostic exit code', async () => {
    const fixture = createFixture({ files: { 'main.ts': 'function save() { localStorage.clear(); }' }, entries: ['main.ts'] });
    try {
      writeConfig({ root: fixture.root, files: ['main.ts'] });
      const plain = await executeEffectsCommand({ root: fixture.root, argv: ['check', '--json'] });
      const plainReport: unknown = JSON.parse(plain.stdout);
      expect(plainReport).not.toHaveProperty('review');
      const explained = await executeEffectsCommand({ root: fixture.root, argv: ['check', '--json', '--explain'] });
      const report: unknown = JSON.parse(explained.stdout);
      expect(explained.exitCode).toBe(plain.exitCode);
      expect(explained.exitCode).toBe(1);
      expect(report).toHaveProperty('review');
      expect(explained.stdout).toContain('Modeled operation: localStorage.clear');
    } finally {
      fixture.dispose();
    }
  });
});

describe('primitive rationale review', () => {
  it('prints intentional-none without calling it an unsafe suppression', async () => {
    const source = '/** @effects [] */ function inspect() { navigator.storage.persisted(); navigator.storage.persist(); }';
    const fixture = createFixture({ files: { 'main.ts': source }, entries: ['main.ts'] });
    try {
      writeConfig({ root: fixture.root, files: ['main.ts'] });
      const result = await executeEffectsCommand({ root: fixture.root, argv: ['check', '--explain'] });
      expect(result.exitCode).toBe(0);
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

  it('includes zero-effect policy decisions with locations in opt-in JSON', async () => {
    const fixture = createFixture({ files: { 'main.ts': '/** @effects [] */ function inspect() { navigator.storage.estimate(); }' }, entries: ['main.ts'] });
    try {
      writeConfig({ root: fixture.root, files: ['main.ts'] });
      const result = await executeEffectsCommand({ root: fixture.root, argv: ['check', '--explain', '--json'] });
      expect(result.exitCode).toBe(0);
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

describe('explicit unresolved candidate writes', () => {
  it('writes a file warning even when a class body has no inferred function contract', async () => {
    const fixture = createFixture({ files: { 'main.ts': "class Transport { send() { fetch('/x'); } }" }, entries: ['main.ts'] });
    try {
      writeConfig({ root: fixture.root, files: ['main.ts'] });
      const draft = await executeEffectsCommand({ root: fixture.root, argv: ['fix', '--allow-unresolved', '--json'] });
      expect(draft.exitCode).toBe(0);
      expect(JSON.parse(draft.stdout)).toMatchObject({ verification: 'unverified', unresolved: { mode: 'fix', write: 'write' } });
      expect(JSON.parse(draft.stdout).diagnostics.some((item: { code: string }) => item.code === 'unsupported')).toBe(true);
      const source = fs.readFileSync(path.join(fixture.root, 'main.ts'), 'utf8');
      expect(source).toContain('UNVERIFIED effect candidates; unresolved bodies/paths may be omitted.');
      expect(source).not.toContain('@effects []');
      const check = await executeEffectsCommand({ root: fixture.root, argv: ['check', '--json'] });
      expect(check.exitCode).toBe(1);
      expect(JSON.parse(check.stdout).verification).toBe('unverified');
      const repeated = await executeEffectsCommand({ root: fixture.root, argv: ['fix', '--allow-unresolved', '--json'] });
      expect(repeated.exitCode).toBe(0);
      expect(JSON.parse(repeated.stdout).changedFiles).toEqual([]);
      expect(fs.readFileSync(path.join(fixture.root, 'main.ts'), 'utf8')).toBe(source);
    } finally {
      fixture.dispose();
    }
  }, 30_000);

  it('removes the unverified warning only after a normal projected fix verifies', async () => {
    const fixture = createFixture({ files: { 'main.ts': 'function save() { localStorage.clear(); }' }, entries: ['main.ts'] });
    try {
      writeConfig({ root: fixture.root, files: ['main.ts'] });
      expect((await executeEffectsCommand({ root: fixture.root, argv: ['fix', '--allow-unresolved'] })).exitCode).toBe(0);
      const fixed = await executeEffectsCommand({ root: fixture.root, argv: ['fix', '--json'] });
      expect(fixed.exitCode).toBe(0);
      expect(JSON.parse(fixed.stdout).verification).toBe('verified');
      const source = fs.readFileSync(path.join(fixture.root, 'main.ts'), 'utf8');
      expect(source).not.toContain('UNVERIFIED');
      expect(source).toContain('@effects ["localstorage.write(*)"]');
    } finally {
      fixture.dispose();
    }
  });

  it('keeps write failures nonzero and rejects the option on check', async () => {
    const fixture = createFixture({ files: { 'main.ts': 'function save() { localStorage.clear(); }' }, entries: ['main.ts'] });
    try {
      writeConfig({ root: fixture.root, files: ['main.ts'] });
      const invalid = await executeEffectsCommand({ root: fixture.root, argv: ['check', '--allow-unresolved'] });
      expect(invalid.exitCode).toBe(2);
      expect(invalid.stderr).toContain('valid only for fix or tidy');
      fs.renameSync(path.join(fixture.root, 'main.ts'), path.join(fixture.root, 'target.ts'));
      fs.symlinkSync(path.join(fixture.root, 'target.ts'), path.join(fixture.root, 'main.ts'));
      const result = await executeEffectsCommand({ root: fixture.root, argv: ['fix', '--allow-unresolved'] });
      expect(result.exitCode).toBe(2);
      expect(result.stderr).toContain('Effect fix failed');
      expect(fs.readFileSync(path.join(fixture.root, 'target.ts'), 'utf8')).toBe('function save() { localStorage.clear(); }');
    } finally {
      fixture.dispose();
    }
  });
});
