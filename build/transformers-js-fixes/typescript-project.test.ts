// @vitest-environment node
import { readFileSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { expect, it } from 'vitest';

const projectRoot = process.cwd();
const fixesRoot = path.join(projectRoot, 'build/transformers-js-fixes');

function readAppProject() {
  const parsed = ts.getParsedCommandLineOfConfigFile(path.join(projectRoot, 'tsconfig.app.json'), {}, {
    ...ts.sys,
    onUnRecoverableConfigFileDiagnostic: diagnostic => {
      throw new Error(ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'));
    },
  });
  if (parsed === undefined) throw new Error('Could not read the application TypeScript project');
  expect(parsed.errors).toEqual([]);
  return parsed;
}

function importedFixFiles({ options }: { options: ts.CompilerOptions }) {
  // These real application-test consumers cover the artifact and bundled Jinja
  // entry points. Follow their imports without executing a build or the runtime.
  const pending = [
    path.join(projectRoot, 'src/features/transformers-js/runtime/fixtures/production-transformers-artifact.ts'),
    path.join(projectRoot, 'src/features/transformers-js/worker/entry.test.ts'),
  ];
  const found = new Set<string>();
  while (pending.length > 0) {
    const file = pending.pop();
    if (file === undefined) throw new Error('Missing import traversal entry');
    for (const imported of ts.preProcessFile(readFileSync(file, 'utf8')).importedFiles) {
      const resolved = ts.resolveModuleName(imported.fileName, file, options, ts.sys).resolvedModule;
      if (resolved === undefined || !resolved.resolvedFileName.startsWith(`${fixesRoot}${path.sep}`)
        || !resolved.resolvedFileName.endsWith('.ts') || found.has(resolved.resolvedFileName)) continue;
      found.add(resolved.resolvedFileName);
      pending.push(resolved.resolvedFileName);
    }
  }
  return [...found].sort();
}

it('includes the shared fixes import closure in the composite application project', () => {
  const project = readAppProject();
  expect(project.options.composite).toBe(true);
  const required = importedFixFiles({ options: project.options });
  expect(required.map(file => path.relative(fixesRoot, file))).toEqual(expect.arrayContaining([
    'artifact.ts', 'jinja-template-fixture.ts',
  ]));
  const rootFiles = new Set(project.fileNames);
  expect(required.filter(file => !rootFiles.has(file)).map(file => path.relative(projectRoot, file))).toEqual([]);
});

it('detects the former source-only root list even though module resolution succeeds', () => {
  const project = readAppProject();
  const sourceOnlyRoots = new Set(project.fileNames.filter(file => !file.startsWith(`${fixesRoot}${path.sep}`)));
  const required = importedFixFiles({ options: project.options });
  // Composite projects require root-file membership, not merely a resolvable
  // import. Disabling composite in a narrow check would hide this regression.
  expect(required.filter(file => !sourceOnlyRoots.has(file))).toEqual(required);
  expect(required.length).toBeGreaterThan(0);
});
