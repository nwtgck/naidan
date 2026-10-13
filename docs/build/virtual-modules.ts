import { readFile, lstat } from 'node:fs/promises';
import path from 'node:path';
import type { Plugin } from 'vite';
import { DOCS_PAGES } from '../site/routes';
import { REGISTRY_ID, styleEntryId } from './ids';
import { validateStaticComponent } from './source-policy';

export function createDocsModulesPlugin({ root }: { root: string }): Plugin {
  const stylePages = new Map(DOCS_PAGES.map(page => [styleEntryId({ page: page.id }), page]));
  return {
    name: 'naidan-docs-modules',
    enforce: 'pre',
    resolveId(id) {
      if (id === REGISTRY_ID || stylePages.has(id)) return `\0${id}`;
      return undefined;
    },
    async load(id, options) {
      if (!id.startsWith('\0')) return undefined;
      const name = id.slice(1);
      if (name === REGISTRY_ID) {
        if (!options?.ssr) throw new Error('The Docs page and translation registry is server-only');
        const lines = [
          'import { pageMessageSchemas, commonMessagesSchema } from "/site/messages.ts";',
          'import { strings as commonEn } from "/strings/common/en.ts";',
          'import { strings as commonJa } from "/strings/common/ja.ts";',
          'export const common = { en: commonMessagesSchema.parse(commonEn), ja: commonMessagesSchema.parse(commonJa) };',
        ];
        const records: string[] = [];
        for (const page of DOCS_PAGES) {
          const symbol = page.id.replaceAll('/', '_').replaceAll('-', '_');
          for (const source of [page.source, `strings/${page.id}/en.ts`, `strings/${page.id}/ja.ts`]) {
            const file = path.resolve(root, source);
            const stat = await lstat(file);
            if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Docs source must be a regular file: ${source}`);
            this.addWatchFile(file);
          }
          lines.push(`import ${symbol}Page from ${JSON.stringify(`/${page.source}`)};`);
          for (const locale of ['en', 'ja']) {
            lines.push(`import { strings as ${symbol}_${locale} } from ${JSON.stringify(`/strings/${page.id}/${locale}.ts`)};`);
          }
          records.push(`${JSON.stringify(page.id)}: { component: ${symbol}Page, messages: { en: pageMessageSchemas[${JSON.stringify(page.id)}].parse(${symbol}_en), ja: pageMessageSchemas[${JSON.stringify(page.id)}].parse(${symbol}_ja) } }`);
        }
        lines.push(`export const pages = { ${records.join(',')} };`);
        return lines.join('\n');
      }
      const page = stylePages.get(name);
      if (page) {
        // Use normal SFC imports. Vue/Vite own CSS extraction, scoped IDs, nested
        // style imports and url() assets; this plugin never reconstructs them.
        // Exports keep nested SFC imports reachable during tree-shaking. These
        // collection entries are never loaded by static documents.
        return `import "/site/site.css"; export { default as layout } from "/site/DocLayout.vue"; export { default as page } from ${JSON.stringify(`/${page.source}`)};`;
      }
      return undefined;
    },
    async transform(_source, id) {
      // These are filesystem IDs, not request URLs. Preserve drive letters,
      // spaces and literal percent signs; generated Vue subrequests have queries.
      if (id.includes('\0') || id.includes('?') || !id.endsWith('.vue')) return undefined;
      const filename = id;
      const relative = path.relative(root, filename);
      if (relative.startsWith('..') || path.isAbsolute(relative)) return undefined;
      const source = await readFile(filename, 'utf8');
      validateStaticComponent({ source, filename, mode: relative.startsWith(`islands${path.sep}`) ? 'island' : 'static' });
      return undefined;
    },
  };
}
