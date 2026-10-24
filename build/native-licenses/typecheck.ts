import ts from 'typescript';

/** The direct Vite commands do not typecheck application code. Check only the
 * selected JSON import adapter and its pure contract, including for vite build.
 * No application compilation, subprocess, generated source or schema gate.
 */
export function assertNativeLicenseTypeContract({ fileName }: { fileName: string }): void {
  const program = ts.createProgram({
    rootNames: [fileName],
    options: {
      target: ts.ScriptTarget.ES2023,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      resolveJsonModule: true,
      strict: true,
      noEmit: true,
      skipLibCheck: true,
      types: [],
    },
  });
  const errors = ts.getPreEmitDiagnostics(program).filter(diagnostic => diagnostic.category === ts.DiagnosticCategory.Error);
  if (errors.length > 0) {
    throw new Error(`Native license JSON violates the TypeScript contract:\n${ts.formatDiagnostics(errors, {
      getCanonicalFileName: name => name,
      getCurrentDirectory: () => process.cwd(),
      getNewLine: () => '\n',
    })}`);
  }
}

export const TEST_ONLY = {
};
