import fs from 'node:fs';
import path from 'node:path';
import { executeEffectsCommand } from '../cli.ts';
import { runEffects } from '../index.ts';
import { describe, expect, it } from 'vitest';
import { createFixture } from '../test-support/project-fixture.ts';

function configuredFixture({ files, entries }: { files: Readonly<Record<string, string>>, entries: readonly string[] }) {
  const fixture = createFixture({ files, entries });
  fs.writeFileSync(path.join(fixture.root, 'effects.config.ts'), 'export default ' + JSON.stringify(fixture.config) + ';');
  return fixture;
}

describe('maintenance commands use the production engine', () => {
  it('defaults tidy to preview, writes only with --write, and emits no change on a second run', async () => {
    const source = '/** @effects ["network.http(*)"] */ export function run() {}';
    const fixture = configuredFixture({ files: { 'main.ts': source }, entries: ['main.ts'] });
    try {
      const preview = await executeEffectsCommand({ root: fixture.root, argv: ['tidy', '--json'] });
      expect(preview.stderr).toBe('');
      expect(preview.exitCode).toBe(0);
      expect(JSON.parse(preview.stdout)).toMatchObject({ changedFiles: [], tidy: { mode: 'preview', changes: [{ label: 'run', before: ['network.http(*)'], after: [] }] } });
      expect(fs.readFileSync(path.join(fixture.root, 'main.ts'), 'utf8')).toBe(source);
      const textPreview = await executeEffectsCommand({ root: fixture.root, argv: ['tidy'] });
      expect(textPreview.exitCode).toBe(0);
      expect(textPreview.stdout).toContain('run (annotation removed)');
      const written = await executeEffectsCommand({ root: fixture.root, argv: ['tidy', '--write', '--json'] });
      expect(written.exitCode).toBe(0);
      expect(JSON.parse(written.stdout).changedFiles).toHaveLength(1);
      const repeated = await executeEffectsCommand({ root: fixture.root, argv: ['tidy', '--json'] });
      expect(repeated.exitCode).toBe(0);
      expect(JSON.parse(repeated.stdout).tidy.changes).toEqual([]);
    } finally {
      fixture.dispose();
    }
  }, 30_000);

  it('uses --file as analysis entries for tidy preview and write without unrelated configured blockers', async () => {
    const main = '/** @effects ["network.http(*)"] */ export function run() {}';
    const other = '/** @effects [] */ export function invalid() { fetch("/x"); }';
    const fixture = configuredFixture({
      files: {
        'main.ts': main,
        'other.ts': other,
      },
      entries: ['other.ts'],
    });
    try {
      const preview = await executeEffectsCommand({ root: fixture.root, argv: ['tidy', '--file', 'main.ts', '--json'] });
      expect(preview.stderr).toBe('');
      expect(preview.exitCode).toBe(0);
      expect(JSON.parse(preview.stdout)).toMatchObject({
        scope: { files: [path.join(fixture.root, 'main.ts')] },
        changedFiles: [],
        tidy: { changes: [{ label: 'run', before: ['network.http(*)'], after: [] }] },
      });
      expect(fs.readFileSync(path.join(fixture.root, 'main.ts'), 'utf8')).toBe(main);
      const written = await executeEffectsCommand({ root: fixture.root, argv: ['tidy', '--file', 'main.ts', '--write', '--json'] });
      expect(written.stderr).toBe('');
      expect(written.exitCode).toBe(0);
      expect(JSON.parse(written.stdout).changedFiles).toEqual([path.join(fixture.root, 'main.ts')]);
      expect(fs.readFileSync(path.join(fixture.root, 'main.ts'), 'utf8')).not.toContain('@effects');
      expect(fs.readFileSync(path.join(fixture.root, 'other.ts'), 'utf8')).toBe(other);
    } finally {
      fixture.dispose();
    }
  }, 30_000);

  it('validates reached dependencies while preserving their bounds outside the tidy edit selection', async () => {
    const dependency = '/** @effects ["localstorage.read(*)", "network.http(*)"] */ export function read() { localStorage.getItem("key"); }';
    const fixture = configuredFixture({
      files: {
        'main.ts': 'import { read } from "./dependency"; /** @effects ["localstorage.read(*)", "network.http(*)", "opfs.read(*)"] */ export function run() { read(); }',
        'dependency.ts': dependency,
        'other.ts': '/** @effects [] */ export function invalid() { fetch("/x"); }',
      },
      entries: ['other.ts'],
    });
    try {
      const preview = await executeEffectsCommand({ root: fixture.root, argv: ['tidy', '--file', 'main.ts', '--json'] });
      expect(preview.stderr).toBe('');
      expect(preview.exitCode).toBe(0);
      const report = JSON.parse(preview.stdout);
      expect(report.scope.files).toEqual(expect.arrayContaining([path.join(fixture.root, 'main.ts'), path.join(fixture.root, 'dependency.ts')]));
      expect(report.scope.files).toHaveLength(2);
      expect(report.tidy.changes).toMatchObject([{ file: 'main.ts', after: ['localstorage.read(*)', 'network.http(*)'] }]);
      expect(report.tidy.selections).toEqual(expect.arrayContaining([expect.objectContaining({ file: 'dependency.ts', disposition: 'preserve' })]));
      expect(fs.readFileSync(path.join(fixture.root, 'dependency.ts'), 'utf8')).toBe(dependency);
      fs.writeFileSync(path.join(fixture.root, 'dependency.ts'), dependency.replace('localStorage.getItem("key");', 'localStorage.clear();'));
      const blocked = await executeEffectsCommand({ root: fixture.root, argv: ['tidy', '--file', 'main.ts'] });
      expect(blocked.exitCode).toBe(2);
      expect(blocked.stderr).toContain('clean ordinary check');
    } finally {
      fixture.dispose();
    }
  }, 30_000);

  it('uses --file analysis entries for unresolved tidy and writes candidates only in the edit selection', async () => {
    const main = 'import { marker } from "./dependency"; export class Transport { send() { fetch("/x"); return marker; } }';
    const dependency = 'export const marker = 1;';
    const other = 'export function unrelated() { localStorage.clear(); }';
    const fixture = configuredFixture({
      files: { 'main.ts': main, 'dependency.ts': dependency, 'other.ts': other },
      entries: ['other.ts'],
    });
    try {
      const preview = await executeEffectsCommand({ root: fixture.root, argv: ['tidy', '--file', 'main.ts', '--allow-unresolved', '--json'] });
      expect(preview.stderr).toBe('');
      expect(preview.exitCode).toBe(0);
      const report = JSON.parse(preview.stdout);
      expect(report.verification).toBe('unverified');
      expect(report.scope.files).toEqual(expect.arrayContaining([path.join(fixture.root, 'main.ts'), path.join(fixture.root, 'dependency.ts')]));
      expect(report.scope.files).toHaveLength(2);
      expect(report.unresolved).toMatchObject({ mode: 'tidy', write: 'preview', plannedFiles: ['main.ts'] });
      expect(report.changedFiles).toEqual([]);
      expect(fs.readFileSync(path.join(fixture.root, 'main.ts'), 'utf8')).toBe(main);
      const written = await executeEffectsCommand({ root: fixture.root, argv: ['tidy', '--file', 'main.ts', '--allow-unresolved', '--write', '--json'] });
      expect(written.stderr).toBe('');
      expect(written.exitCode).toBe(0);
      expect(JSON.parse(written.stdout).changedFiles).toEqual([path.join(fixture.root, 'main.ts')]);
      expect(fs.readFileSync(path.join(fixture.root, 'main.ts'), 'utf8')).toContain('UNVERIFIED effect candidates');
      expect(fs.readFileSync(path.join(fixture.root, 'dependency.ts'), 'utf8')).toBe(dependency);
      expect(fs.readFileSync(path.join(fixture.root, 'other.ts'), 'utf8')).toBe(other);
    } finally {
      fixture.dispose();
    }
  }, 30_000);

  it.each(['check', 'fix'])('rejects --write on %s without editing', async mode => {
    const fixture = configuredFixture({ files: { 'main.ts': 'function run() {}' }, entries: ['main.ts'] });
    try {
      const result = await executeEffectsCommand({ root: fixture.root, argv: [mode, '--write'] });
      expect(result.exitCode).toBe(2);
      expect(result.stderr).toContain('--write is valid only for tidy');
      expect(fs.readFileSync(path.join(fixture.root, 'main.ts'), 'utf8')).toBe('function run() {}');
    } finally {
      fixture.dispose();
    }
  });
});

describe('explicit effect edit selection', () => {
  const unsafe = '/** @effectsUNSAFE {"effects":["network.http(*)"],"reason":"Reviewed author exception."} */';
  const main = `\
import { read } from '../shared/dependency';
/** @effects ["localstorage.read(*)","network.http(*)"] */
export function run() { return read(); }
/** @effects [] */
${unsafe}
export function probe() { fetch('/probe'); }
`;
  const dependency = 'export function read() { return localStorage.getItem("key"); }';
  const sources = {
    'feature/main.ts': main,
    'feature/second.ts': 'export function save() { localStorage.clear(); }',
    'feature/main.test.ts': 'export function fixture() { fetch("/test"); }',
    'feature/ambient.d.ts': 'declare const ignoredAmbient: string;',
    'feature/excluded.ts': 'export function excluded() { fetch("/excluded"); }',
    'feature/node_modules/pkg/index.ts': 'export function external() { fetch("/package"); }',
    'shared/dependency.ts': dependency,
    'other.ts': 'export function unrelated() { fetch("/unrelated"); }',
  };

  function selectionFixture({ files, entries }: { files: Readonly<Record<string, string>>, entries: readonly string[] }) {
    const fixture = configuredFixture({ files, entries });
    const configFile = path.join(fixture.root, 'tsconfig.json');
    const config = JSON.parse(fs.readFileSync(configFile, 'utf8'));
    config.exclude = ['**/*.test.ts', 'feature/excluded.ts', 'effects.config.ts'];
    fs.writeFileSync(configFile, JSON.stringify(config));
    return fixture;
  }

  it.each([
    { name: 'one file', selectors: ['feature/main.ts'], entries: ['feature/main.ts'], expected: ['feature/main.ts'] },
    { name: 'multiple files', selectors: ['feature/main.ts', 'feature/second.ts'], entries: ['feature/main.ts', 'feature/second.ts'], expected: ['feature/main.ts', 'feature/second.ts'] },
    { name: 'a directory', selectors: ['feature'], entries: ['feature/main.ts', 'feature/second.ts'], expected: ['feature/main.ts', 'feature/second.ts'] },
    { name: 'overlapping file and directory', selectors: ['feature/main.ts', 'feature'], entries: ['feature/main.ts', 'feature/second.ts'], expected: ['feature/main.ts', 'feature/second.ts'] },
    { name: 'the root directory', selectors: ['.'], entries: ['feature/main.ts', 'feature/second.ts', 'other.ts', 'shared/dependency.ts'], expected: ['feature/main.ts', 'feature/second.ts', 'other.ts', 'shared/dependency.ts'] },
    { name: 'no selector', selectors: undefined, entries: ['feature/main.ts'], expected: ['feature/main.ts', 'shared/dependency.ts'] },
  ])('limits draft writes for $name, preserves authors and matches the API preview', async ({ selectors, entries, expected }) => {
    const fixture = selectionFixture({ files: sources, entries: selectors === undefined ? entries : ['other.ts'] });
    try {
      const preview = runEffects({ root: fixture.root, config: { ...fixture.config, files: entries }, mode: 'fix', inputSnapshots: new Map(), files: selectors === undefined ? undefined : entries, unresolved: { mode: 'fix', write: 'preview' } });
      expect(preview.changedFiles).toEqual([]);
      expect(preview.unresolved?.plannedFiles.map(file => path.relative(fixture.root, file)).sort()).toEqual(expected);
      for (const [file, source] of Object.entries(sources)) expect(fs.readFileSync(path.join(fixture.root, file), 'utf8')).toBe(source);
      const result = await executeEffectsCommand({ root: fixture.root, argv: ['fix', '--allow-unresolved', '--json', ...(selectors ?? []).flatMap(file => ['--file', file])] });
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe('');
      const report = JSON.parse(result.stdout);
      expect(report.verification).toBe('unverified');
      expect(report.unresolved.plannedFiles.sort()).toEqual(expected);
      expect(report.changedFiles.map((file: string) => path.relative(fixture.root, file)).sort()).toEqual(expected);
      const actual = Object.entries(sources).flatMap(([file, source]) => fs.readFileSync(path.join(fixture.root, file), 'utf8') === source ? [] : [file]).sort();
      expect(actual).toEqual(expected);
      for (const file of expected) expect(fs.readFileSync(path.join(fixture.root, file), 'utf8')).toBe(preview.analysis.sources.get(path.join(fixture.root, file)));
      const authored = fs.readFileSync(path.join(fixture.root, 'feature/main.ts'), 'utf8');
      expect(authored).toContain('/** @effects ["localstorage.read(*)","network.http(*)"] */');
      expect(authored).toContain(unsafe);
      expect(report.unsafeSuppressions).toEqual([expect.objectContaining({ reason: 'Reviewed author exception.' })]);
      if (!expected.includes('shared/dependency.ts')) {
        expect(report.diagnostics).toEqual(expect.arrayContaining([expect.objectContaining({ file: path.join(fixture.root, 'shared/dependency.ts'), code: 'missing' })]));
      }
    } finally {
      fixture.dispose();
    }
  }, 30_000);

  it.each([
    { name: 'one file with a checked dependency', selectors: ['feature/main.ts'], cleanDependency: true, exitCode: 0, expected: ['feature/main.ts'] },
    { name: 'a directory with a checked dependency', selectors: ['feature'], cleanDependency: true, exitCode: 0, expected: ['feature/main.ts', 'feature/second.ts'] },
    { name: 'an unchecked unselected dependency', selectors: ['feature/main.ts'], cleanDependency: false, exitCode: 2, expected: [] },
    { name: 'no selector with an unchecked dependency', selectors: undefined, cleanDependency: false, exitCode: 0, expected: ['feature/main.ts', 'shared/dependency.ts'] },
  ])('keeps strict closure validation for $name', async ({ selectors, cleanDependency, exitCode, expected }) => {
    const entry = main.replace('/** @effects ["localstorage.read(*)","network.http(*)"] */', '');
    const fixture = selectionFixture({ files: { ...sources, 'feature/main.ts': entry, 'shared/dependency.ts': (cleanDependency ? '/** @effects ["localstorage.read(*)"] */ ' : '') + dependency }, entries: ['feature/main.ts'] });
    const before = new Map(Object.keys(sources).map(file => [file, fs.readFileSync(path.join(fixture.root, file), 'utf8')]));
    try {
      const argv = ['fix', '--json', ...(selectors ?? []).flatMap(file => ['--file', file])];
      const result = await executeEffectsCommand({ root: fixture.root, argv });
      expect(result.exitCode).toBe(exitCode);
      const actual = [...before].flatMap(([file, source]) => fs.readFileSync(path.join(fixture.root, file), 'utf8') === source ? [] : [file]).sort();
      expect(actual).toEqual(expected);
      expect(fs.readFileSync(path.join(fixture.root, 'feature/main.ts'), 'utf8')).toContain(unsafe);
      if (exitCode === 2) {
        expect(result.stderr).toContain('Missing @effects contract for read.');
        expect(result.stderr).toContain('Effect fix did not verify before writing');
      } else {
        expect(JSON.parse(result.stdout).diagnostics).toEqual([]);
        const repeated = await executeEffectsCommand({ root: fixture.root, argv });
        expect(repeated.exitCode).toBe(0);
        expect(JSON.parse(repeated.stdout).changedFiles).toEqual([]);
      }
    } finally {
      fixture.dispose();
    }
  }, 30_000);
});
