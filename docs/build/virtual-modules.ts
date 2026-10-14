import path from 'node:path';
import type { Plugin } from 'vite';
import { DOCS_PAGES } from '../site/routes';
import { ISLAND_ENTRIES, REGISTRY_ID, styleEntryId } from './ids';
import { validateDocsAuthoringSource } from './authoring-policy';

export function createDocsModulesPlugin({ root }: { root: string }): Plugin {
  const stylePages = new Map(DOCS_PAGES.map(page => [styleEntryId({ page: page.id }), page]));
  const clientEntries = new Map(Object.entries(ISLAND_ENTRIES).map(([id, entry]) => [entry, id]));
  return {
    name: 'naidan-docs-modules',
    enforce: 'pre',
    resolveId(id) {
      if (id === REGISTRY_ID || stylePages.has(id) || clientEntries.has(id)) return `\0${id}`;
      return undefined;
    },
    async load(id, options) {
      if (!id.startsWith('\0')) return undefined;
      const name = id.slice(1);
      if (name === REGISTRY_ID) {
        if (!options?.ssr) throw new Error('The Docs page and translation registry is server-only');
        const lines = [
          'import { lstat } from "node:fs/promises";',
          'import path from "node:path";',
          `const root = ${JSON.stringify(root)};`,
          'async function checked({ source, load }) { const stat = await lstat(path.resolve(root, source)); if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Docs source must be a regular file: ${source}`); return load(); }',
          'export const common = {',
          '  en: () => checked({ source: "strings/common/en.ts", load: () => import("/strings/common/en.ts") }),',
          '  ja: () => checked({ source: "strings/common/ja.ts", load: () => import("/strings/common/ja.ts") }),',
          '};',
        ];
        const records: string[] = [];
        for (const page of DOCS_PAGES) {
          const strings = `pages/${page.id}/strings`;
          for (const source of [page.source, `${strings}/en.ts`, `${strings}/ja.ts`]) {
            const file = path.resolve(root, source);
            this.addWatchFile(file);
          }
          const component = `() => checked({ source: ${JSON.stringify(page.source)}, load: () => import(${JSON.stringify(`/${page.source}`)}) })`;
          const en = `() => checked({ source: ${JSON.stringify(`${strings}/en.ts`)}, load: () => import(${JSON.stringify(`/${strings}/en.ts`)}) })`;
          const ja = `() => checked({ source: ${JSON.stringify(`${strings}/ja.ts`)}, load: () => import(${JSON.stringify(`/${strings}/ja.ts`)}) })`;
          records.push(`${JSON.stringify(page.id)}: { component: ${component}, messages: { en: ${en}, ja: ${ja} } }`);
        }
        lines.push(`export const pages = { ${records.join(',')} };`);
        return lines.join('\n');
      }
      const island = clientEntries.get(name);
      if (island) {
        return `import { startDocsIslandHydration } from "/islands/core.ts"; import { ${island.replaceAll(/-([a-z])/gu, (_, letter: string) => letter.toUpperCase())}Island } from "/islands/${island}/definition.ts"; startDocsIslandHydration({ factory: ${island.replaceAll(/-([a-z])/gu, (_, letter: string) => letter.toUpperCase())}Island, document });`;
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
    async transform(source, id) {
      // These are filesystem IDs, not request URLs. Preserve drive letters,
      // spaces and literal percent signs; generated Vue subrequests have queries.
      if (id.includes('\0') || id.includes('?') || !/\.(?:vue|ts|js)$/u.test(id)) return undefined;
      const filename = id;
      const relative = path.relative(root, filename);
      if (relative.startsWith('..') || path.isAbsolute(relative)) return undefined;
      const docsFile = relative.split(path.sep).join('/');
      if (/^(?:build|tests|\.cache|dist)\//u.test(docsFile) || /(?:^|\/)\w+\.config\.[jt]s$/u.test(docsFile)) return undefined;
      await validateDocsAuthoringSource({
        source,
        filename: docsFile,
        root,
        resolve: async ({ specifier, importer }) => (await this.resolve(specifier, importer, { skipSelf: true }))?.id,
      });
      return undefined;
    },
  };
}
