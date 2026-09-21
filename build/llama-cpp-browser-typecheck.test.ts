// @vitest-environment node
import path from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

describe('browser core packaging type boundary', () => {
  it('keeps the actual app composite contract in a targeted dependency graph', () => {
    const root = process.cwd();
    const configPath = path.join(root, 'tsconfig.app.json');
    const config = ts.readConfigFile(configPath, ts.sys.readFile);
    expect(config.error).toBeUndefined();
    const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, root, undefined, configPath);
    expect(parsed.errors).toEqual([]);
    expect(parsed.options.composite).toBe(true);
    const entry = path.join(root, 'src/features/llama-cpp-browser/build-core.ts');
    // Discover only this entry's dependencies, then use the REAL project's file
    // membership. Adding every discovered file (or disabling composite) hides TS6307.
    const discovered = ts.createProgram([entry], parsed.options);
    const declaredFiles = new Set(parsed.fileNames);
    const roots = discovered.getSourceFiles().map(file => file.fileName).filter(file => declaredFiles.has(file));
    expect(roots).toContain(entry);
    const program = ts.createProgram(roots, parsed.options);
    const diagnostics = ts.getPreEmitDiagnostics(program).map(diagnostic => ({
      code: diagnostic.code,
      message: ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'),
    }));
    expect(diagnostics).toEqual([]);
  });
});
