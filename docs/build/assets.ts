import { z } from 'zod';
import type { Manifest } from 'vite';
import { DOCS_BASE } from '../navigation/routes';

const chunkSchema = z.object({
  file: z.string(),
  name: z.string().optional(),
  src: z.string().optional(),
  isEntry: z.boolean().optional(),
  imports: z.array(z.string()).optional(),
  dynamicImports: z.array(z.string()).optional(),
  css: z.array(z.string()).optional(),
});
const manifestSchema = z.record(z.string(), chunkSchema);

export function parseManifest({ text }: { text: string }): Manifest {
  const raw: unknown = JSON.parse(text);
  return manifestSchema.parse(raw);
}

export function publicAssetHref({ file }: { file: string }): string {
  const base = new URL(DOCS_BASE, 'https://naidan-docs.invalid');
  const url = new URL(file, base);
  if (file.startsWith('/') || file.includes('\\') || file.includes('..') || url.origin !== base.origin
    || !url.pathname.startsWith(DOCS_BASE) || url.search || url.hash) {
    throw new Error(`Invalid Docs asset path: ${file}`);
  }
  return url.pathname;
}

export function manifestEntry({ manifest, name }: { manifest: Manifest; name: string }): { styles: string[]; script: string | undefined } {
  const entries = Object.entries(manifest).filter(([, chunk]) => chunk.isEntry && chunk.name === name);
  if (entries.length !== 1) throw new Error(`Expected one Docs manifest entry ${name}, got ${entries.length}`);
  const entry = entries[0];
  if (!entry) throw new Error(`Missing Docs entry ${name}`);
  const styles = new Set<string>();
  const visited = new Set<string>();
  const visit = ({ key }: { key: string }): void => {
    if (visited.has(key)) return;
    visited.add(key);
    const chunk = manifest[key];
    if (!chunk) throw new Error(`Missing Docs manifest dependency: ${key}`);
    // Async Vue children can be rendered into static HTML too. Their styles
    // must be present even when no client module will execute the import.
    for (const imported of [...(chunk.imports ?? []), ...(chunk.dynamicImports ?? [])]) visit({ key: imported });
    for (const file of chunk.css ?? []) styles.add(publicAssetHref({ file }));
    if (chunk.file.endsWith('.css')) styles.add(publicAssetHref({ file: chunk.file }));
  };
  visit({ key: entry[0] });
  return { styles: [...styles], script: entry[1].file.endsWith('.css') ? undefined : publicAssetHref({ file: entry[1].file }) };
}
