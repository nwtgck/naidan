// @vitest-environment node
import path from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

describe('node environment composite project membership', () => {
  it('keeps the registry in the actual app composite project when a src build module imports it', () => {
    const root = process.cwd();
    const configPath = path.join(root, 'tsconfig.app.json');
    const config = ts.readConfigFile(configPath, ts.sys.readFile);
    expect(config.error).toBeUndefined();
    const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, root, undefined, configPath);
    expect(parsed.errors).toEqual([]);
    expect(parsed.options.composite).toBe(true);
    const registry = path.join(root, 'build/node-env.ts');
    expect(parsed.fileNames).toContain(registry);
    const entry = path.join(root, 'src/features/stable-diffusion-cpp-browser/build-runtime.ts');
    // Check only this dependency graph, but do not add undeclared files or turn
    // off composite: either would conceal TS6307 at the src -> build boundary.
    const discovered = ts.createProgram([entry], parsed.options);
    const declaredFiles = new Set(parsed.fileNames);
    const roots = discovered.getSourceFiles().map(file => file.fileName).filter(file => declaredFiles.has(file));
    expect(roots).toContain(registry);
    const program = ts.createProgram(roots, parsed.options);
    const diagnostics = ts.getPreEmitDiagnostics(program).map(diagnostic => ({ code: diagnostic.code, message: ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n') }));
    expect(diagnostics).toEqual([]);
  }, 30000);
});
