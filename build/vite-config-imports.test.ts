// @vitest-environment node
import { resolve } from 'node:path';
import { build } from 'rolldown';
import { expect, it } from 'vitest';

it('bundles Vite configuration dependencies without application-only path aliases', async () => {
  // Vite bundles its configuration before installing resolve.alias. A bare
  // @/ import in this graph becomes an external package at Node startup.
  const { output } = await build({
    input: resolve(process.cwd(), 'vite.config.ts'),
    platform: 'node',
    external: id => !id.startsWith('.') && !id.startsWith('/') && !id.startsWith('node:'),
    output: { format: 'esm' },
    write: false,
  });
  const configImports = output.flatMap(file => file.type === 'chunk' ? file.imports : []);
  expect(configImports.filter(id => id.startsWith('@/'))).toEqual([]);
});
