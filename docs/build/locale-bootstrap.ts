import path from 'node:path';
import { build } from 'vite';

// Use the same small, self-contained classic script in development and release.
// A blocking head script can select the language before any page body is painted.
// It needs no Vue runtime and imports neither page components nor dictionaries.
export async function compileLocaleBootstrap({ root }: { root: string }): Promise<string> {
  const result = await build({
    configFile: false,
    root,
    logLevel: 'silent',
    publicDir: false,
    css: { postcss: { plugins: [] } },
    build: {
      write: false,
      minify: true,
      sourcemap: false,
      lib: {
        entry: path.resolve(root, 'client/locale.ts'),
        formats: ['iife'],
        name: 'NaidanDocsLocale',
      },
    },
  });
  const output = Array.isArray(result) && result.length === 1 ? result[0] : result;
  if (!output || !('output' in output)) throw new Error('Expected one Docs locale bootstrap bundle');
  const chunks = output.output.filter(item => item.type === 'chunk');
  if (chunks.length !== 1 || output.output.length !== 1) throw new Error('Locale bootstrap must be self-contained');
  const chunk = chunks[0];
  if (!chunk || chunk.imports.length || chunk.dynamicImports.length) throw new Error('Unexpected locale bootstrap dependency');
  return chunk.code;
}
