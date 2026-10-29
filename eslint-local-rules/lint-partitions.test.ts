// @vitest-environment node
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ESLint } from 'eslint';
import * as tsParser from '@typescript-eslint/parser';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(import.meta.dirname, '..');
const firstTargets = ['src/strings', 'src/components'];
const otherIgnores = firstTargets.map(directory => `${directory}/**`);

function createFixture() {
  const directory = mkdtempSync(path.join(tmpdir(), 'naidan-lint-partitions-'));
  return {
    directory,
    write(files: Record<string, string>) {
      for (const [relative, content] of Object.entries(files)) {
        const filename = path.join(directory, relative);
        mkdirSync(path.dirname(filename), { recursive: true });
        writeFileSync(filename, content);
      }
    },
    [Symbol.dispose]() {
      tsParser.clearCaches();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

function createEslint({ directory, ignoreFirstPartition = false }: { directory: string, ignoreFirstPartition?: boolean }) {
  return new ESLint({
    cwd: directory,
    overrideConfigFile: path.join(repoRoot, 'eslint.config.js'),
    ignorePatterns: ignoreFirstPartition ? otherIgnores : [],
    // Only the tiny fixture projects replace Naidan's real TypeScript projects.
    // Keep the actual rules, processors, severity, ignores and inline directives.
    overrideConfig: [
      {
        files: ['src/**/*.{ts,tsx,vue}', 'build/**/*.{ts,tsx,vue}', 'pwa/**/*.{ts,tsx,vue}'],
        languageOptions: {
          parserOptions: {
            project: ['tsconfig.app.json', 'tsconfig.node.json', 'pwa/tsconfig.json'].map(file => path.join(directory, file)),
            tsconfigRootDir: directory,
          },
        },
      },
      {
        files: ['docs/**/*.{ts,tsx,vue}', 'build/docs-dev-bridge.ts'],
        languageOptions: { parserOptions: { project: [path.join(directory, 'docs/tsconfig.json')], tsconfigRootDir: directory } },
      },
    ],
  });
}

function normalize({ results, directory }: { results: ESLint.LintResult[], directory: string }) {
  return results.map(result => ({
    file: path.relative(directory, result.filePath).replaceAll('\\', '/'),
    messages: result.messages,
    suppressedMessages: result.suppressedMessages,
    errorCount: result.errorCount,
    warningCount: result.warningCount,
    fatalErrorCount: result.fatalErrorCount,
    fixableErrorCount: result.fixableErrorCount,
    fixableWarningCount: result.fixableWarningCount,
  })).sort((left, right) => left.file.localeCompare(right.file));
}

describe('two-way CI lint partition contract', () => {
  it('keeps the commands complementary, uncached, non-fixing and single-worker', () => {
    const { scripts } = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
    expect(scripts.lint).toBe('eslint . --max-warnings 0');
    expect(scripts['lint:fix']).toBe('eslint --fix');
    expect(scripts['lint:ci:strings-components']).toBe('eslint src/strings src/components --max-warnings 0 --concurrency off');
    expect(scripts['lint:ci:other']).toBe("eslint . --ignore-pattern 'src/strings/**' --ignore-pattern 'src/components/**' --max-warnings 0 --concurrency off");
  });

  it('keeps both checks isolated and the existing lint gate fail-closed', () => {
    const { jobs } = parse(readFileSync(path.join(repoRoot, '.github/workflows/main.yml'), 'utf8'));
    expect(jobs.lint_checks.strategy).toEqual({
      'fail-fast': false,
      'max-parallel': 2,
      matrix: { scope: ['strings-components', 'other'] },
    });
    expect(jobs.lint_checks['continue-on-error']).toBeUndefined();
    const run = jobs.lint_checks.steps.find((step: { name: string }) => step.name === 'Run lint');
    expect(run['continue-on-error']).toBeUndefined();
    expect(run.run).toContain('--network none');
    expect(run.run).toContain('--cap-drop=ALL');
    expect(run.run).toContain('--security-opt=no-new-privileges:true');
    expect(run.run).toContain('node:22-bookworm npm run lint:ci:${{ matrix.scope }}');
    expect(jobs.lint.needs).toBe('lint_checks');
    expect(jobs.lint.if).toBe('${{ always() }}');
    expect(jobs.lint.steps).toEqual([{
      name: 'Require both lint checks',
      env: { LINT_RESULT: '${{ needs.lint_checks.result }}' },
      run: 'test "$LINT_RESULT" = success',
    }]);
  });

  it('preserves every target and diagnostic across TS, Vue, CSS, docs and owned scripts', async () => {
    using fixture = createFixture();
    const compilerOptions = {
      target: 'ESNext', module: 'ESNext', moduleResolution: 'Bundler',
      strict: true, noEmit: true, types: [], lib: ['ESNext', 'DOM'], jsx: 'preserve',
    };
    const checkedFiles = {
      'src/strings/messages/example/en.ts': 'export default () => "Ready";\n',
      'src/strings/messages/example/future-locale.ts': 'export default () => "Ready";\n',
      'src/strings/catalogs/en.ts': 'export const catalog = { title: () => "Ready" };\n',
      'src/strings/unsafe.ts': 'declare const worker: Worker;\nworker.postMessage({});\n',
      'src/strings/suppressed.ts': '// eslint-disable-next-line @typescript-eslint/no-explicit-any -- fixture\nexport const value: any = 1;\n',
      'src/strings/unused-directive.ts': '// eslint-disable-next-line no-alert\nexport const unusedDirective = 1;\n',
      'src/stringsExtra/other.ts': 'export const notInStrings = 1;\n',
      'src/componentsExtra/other.ts': 'export const notInComponents = 1;\n',
      'src/components/nested/future-component.ts': 'export const value: any = 1;\n',
      'src/components/style.css': '.box{color:red;background:blue;}\n',
      'src/main.ts': 'export const value: any = 1;\n',
      'src/view.tsx': 'export const view = <div />;\n',
      'src/components/View.vue': '<script setup lang="ts">\ndeclare const worker: Worker;\nworker.postMessage({});\n</script>\n<template><div>Ready</div></template>\n<style>.box{color:red;background:blue;}</style>\n',
      'src/View.vue': '<script setup lang="ts">\ndeclare const worker: Worker;\nworker.postMessage({});\n</script>\n<template><div>Ready</div></template>\n<style>.box{color:red;background:blue;}</style>\n',
      'src/style.css': '.box{color:red;background:blue;}\n',
      'src/broken.ts': 'export const = ;\n',
      'build/helper.ts': 'export const helper = 1;\n',
      'pwa/worker.ts': 'export const offline = true;\n',
      'docs/client.ts': 'export const value: any = 1;\n',
      'scripts/owned.mts': 'process.env.PRIVATE_VALUE;\n',
      'eslint-local-rules/example.test.ts': 'export const example = 1;\n',
      '.hidden.js': 'unknownName();\n',
    };
    fixture.write({
      'tsconfig.app.json': JSON.stringify({ compilerOptions, include: ['src/**/*.ts', 'src/**/*.tsx', 'src/**/*.vue'] }),
      'tsconfig.node.json': JSON.stringify({ compilerOptions, include: ['build/**/*.ts'] }),
      'pwa/tsconfig.json': JSON.stringify({ compilerOptions, include: ['*.ts'] }),
      'docs/tsconfig.json': JSON.stringify({ compilerOptions, include: ['*.ts'] }),
      ...checkedFiles,
      'public/ignored.js': 'const = ;',
      'dist/ignored.js': 'const = ;',
      'docs/dist/ignored.js': 'const = ;',
      'node_modules/ignored.js': 'const = ;',
      'src/test-tmp/ignored.ts': 'const = ;',
      'eslint-local-rules/fixtures/ignored.ts': 'const = ;',
      'build/transformers-js-fixes/upstream/ignored.js': 'const = ;',
    });
    const eslint = createEslint({ directory: fixture.directory });
    const baseline = normalize({ results: await eslint.lintFiles(['.']), directory: fixture.directory });
    const first = normalize({ results: await eslint.lintFiles(firstTargets), directory: fixture.directory });
    const other = normalize({
      results: await createEslint({ directory: fixture.directory, ignoreFirstPartition: true }).lintFiles(['.']),
      directory: fixture.directory,
    });
    expect(baseline.map(result => result.file).sort()).toEqual(Object.keys(checkedFiles).sort());
    expect(first.every(result => firstTargets.some(directory => result.file.startsWith(`${directory}/`)))).toBe(true);
    expect(other.every(result => firstTargets.every(directory => !result.file.startsWith(`${directory}/`)))).toBe(true);
    expect([...first, ...other].sort((left, right) => left.file.localeCompare(right.file))).toEqual(baseline);
    // Ensure this is not a vacuous comparison of successful or ignored inputs.
    expect(first.some(result => result.errorCount > 0)).toBe(true);
    expect(first.some(result => result.warningCount > 0)).toBe(true);
    expect(first.some(result => result.suppressedMessages.length > 0)).toBe(true);
    for (const filename of ['src/components/View.vue', 'src/components/style.css']) {
      expect(first.find(result => result.file === filename)!.messages.length).toBeGreaterThan(0);
    }
    expect(other.filter(result => result.fatalErrorCount > 0).map(result => result.file)).toEqual(['src/broken.ts']);
    for (const filename of ['src/View.vue', 'src/style.css', 'docs/client.ts', 'scripts/owned.mts']) {
      expect(other.find(result => result.file === filename)!.messages.length).toBeGreaterThan(0);
    }
  }, 30_000);

  it.each(firstTargets)('sees an other-partition dependency change from %s without changing the consumer', async (directory) => {
    using fixture = createFixture();
    fixture.write({
      'tsconfig.app.json': JSON.stringify({
        compilerOptions: { strict: true, target: 'ESNext', module: 'ESNext', moduleResolution: 'Bundler', noEmit: true, types: [] },
        include: ['src/**/*.ts'],
      }),
      'src/dependency.ts': 'export declare const endpoint: BroadcastChannel;\n',
      [`${directory}/consumer.ts`]: 'import { endpoint } from "../dependency";\nendpoint.postMessage({});\n',
    });
    const consumer = readFileSync(path.join(fixture.directory, directory, 'consumer.ts'), 'utf8');
    const before = await createEslint({ directory: fixture.directory }).lintFiles([directory]);
    const transportMessages = (results: ESLint.LintResult[]) => results.flatMap(result => result.messages)
      .filter(message => message.ruleId === 'local-rules-worker-transport/no-unchecked-worker-transport');
    expect(before.every(result => result.fatalErrorCount === 0)).toBe(true);
    expect(transportMessages(before)).toEqual([]);

    fixture.write({ 'src/dependency.ts': 'export declare const endpoint: Worker;\n' });
    // Model a fresh CI invocation, not an editor's persistent watch program.
    tsParser.clearCaches();
    const after = await createEslint({ directory: fixture.directory }).lintFiles([directory]);
    expect(after.every(result => result.fatalErrorCount === 0)).toBe(true);
    expect(readFileSync(path.join(fixture.directory, directory, 'consumer.ts'), 'utf8')).toBe(consumer);
    expect(transportMessages(after).map(message => message.messageId)).toEqual(['directPostMessage']);
  }, 30_000);
});
