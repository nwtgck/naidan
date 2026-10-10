// @vitest-environment node
import path from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

describe('remote reader recursive schema declarations', () => {
  it('preserves composite checking and emits named recursive types for downstream consumers', () => {
    const root = process.cwd();
    const configPath = path.join(root, 'tsconfig.app.json');
    const config = ts.readConfigFile(configPath, ts.sys.readFile);
    expect(config.error).toBeUndefined();
    const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, root, undefined, configPath);
    expect(parsed.errors).toEqual([]);
    expect(parsed.options.composite).toBe(true);
    expect(parsed.options.noEmit).toBe(true);
    const entry = path.join(root, 'src/features/wesh/naidan-sysfs/remote-reader-schema.ts');
    const probe = path.join(root, 'src/features/wesh/naidan-sysfs/declaration-probe.ts');
    // The real remote reader uses V2. Also compose both versions in a separate
    // module: checking only the DTO's own declarations misses private type leaks.
    const source = `\
import { z } from 'zod';
import { MessageBranchSchemaDtoV1, MessageBranchSchemaDtoV2 } from '@/00-storage/00-dto/dto';
export const branches = z.object({ v1: MessageBranchSchemaDtoV1, v2: MessageBranchSchemaDtoV2 });
export const nested = z.array(branches).optional();
`;
    const host = ts.createCompilerHost(parsed.options);
    const getSourceFile = host.getSourceFile.bind(host);
    host.getSourceFile = (fileName, languageVersion, onError, shouldCreateNewSourceFile) => fileName === probe
      ? ts.createSourceFile(fileName, source, languageVersion, true)
      : getSourceFile(fileName, languageVersion, onError, shouldCreateNewSourceFile);
    const discovered = ts.createProgram([entry, probe], parsed.options, host);
    const declared = new Set(parsed.fileNames);
    // Compile only this dependency graph, but retain the app's actual file
    // membership and composite contract. Disabling composite hid TS4023 before.
    const roots = discovered.getSourceFiles().map(file => file.fileName).filter(file => declared.has(file) || file === probe);
    expect(roots).toContain(entry);
    expect(roots).toContain(probe);
    const checked = ts.createProgram(roots, parsed.options, host);
    const format = ({ diagnostic }: { diagnostic: ts.Diagnostic }) => ({
      code: diagnostic.code,
      file: diagnostic.file?.fileName,
      message: ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'),
    });
    expect(ts.getPreEmitDiagnostics(checked).map(diagnostic => format({ diagnostic }))).toEqual([]);

    const outputs = new Map<string, string>();
    const emitted = ts.createProgram(roots, {
      ...parsed.options,
      noEmit: false,
      declaration: true,
      emitDeclarationOnly: true,
      rootDir: root,
      outDir: path.join(root, 'node_modules/.tmp/dtozod-declaration-test'),
    }, host);
    expect(ts.getPreEmitDiagnostics(emitted).map(diagnostic => format({ diagnostic }))).toEqual([]);
    // Keep all outputs in memory: this regression test never builds or rewrites
    // application files, tsbuildinfo, or declarations on disk.
    const result = emitted.emit(undefined, (fileName, text) => outputs.set(fileName, text), undefined, true);
    expect(result.emitSkipped).toBe(false);
    expect(result.diagnostics.map(diagnostic => format({ diagnostic }))).toEqual([]);
    const remote = [...outputs].find(([fileName]) => fileName.endsWith('/remote-reader-schema.d.ts'))?.[1];
    expect(remote).toContain('naidanSysfsRemoteChatContentPayloadSchema');
    expect(remote).toContain('naidanSysfsRemoteChatPayloadSchema');
    const branches = [...outputs].find(([fileName]) => fileName.endsWith('/declaration-probe.d.ts'))?.[1];
    expect(branches).toContain('MessageBranchSchemaTypeDtoV1');
    expect(branches).toContain('MessageBranchSchemaTypeDtoV2');
    expect([...outputs.keys()].some(fileName => fileName.endsWith('.js'))).toBe(false);
  }, 30_000);
});
