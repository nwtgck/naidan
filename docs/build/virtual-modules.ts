import path from 'node:path';
import { transformAsync } from '@babel/core';
import vueJsx from '@vue/babel-plugin-jsx';
import type { Plugin } from 'vite';
import { DOCS_PAGES } from '../navigation/routes';
import { ISLAND_ENTRIES, REGISTRY_ID, styleEntryId } from './ids';
import { validateDocsAuthoringSource } from './authoring-policy';

function articleTranslationFile({ root, id }: { root: string; id: string }): string | undefined {
  const filename = id.split('?', 1)[0] ?? id;
  const relative = path.relative(root, filename);
  if (relative.startsWith('..') || path.isAbsolute(relative)) return undefined;
  const docsFile = relative.split(path.sep).join('/');
  return /^pages\/[^/]+\/messages\/(?:en|ja)\.tsx$/u.test(docsFile) ? docsFile : undefined;
}

export function createDocsModulesPlugin({ root, allowTestArticleTranslations = false }: { root: string; allowTestArticleTranslations?: boolean }): Plugin {
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
      const translation = articleTranslationFile({ root, id });
      if (translation && !options?.ssr && !allowTestArticleTranslations) throw new Error(`Docs article translations are server-only: ${translation}`);
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
          '  en: () => checked({ source: "messages/common/en.ts", load: () => import("/messages/common/en.ts") }),',
          '  ja: () => checked({ source: "messages/common/ja.ts", load: () => import("/messages/common/ja.ts") }),',
          '};',
        ];
        const records: string[] = [];
        for (const page of DOCS_PAGES) {
          const messages = `pages/${page.id}/messages`;
          for (const source of [page.source, `${messages}/en.tsx`, `${messages}/ja.tsx`]) {
            const file = path.resolve(root, source);
            this.addWatchFile(file);
          }
          const component = `() => checked({ source: ${JSON.stringify(page.source)}, load: () => import(${JSON.stringify(`/${page.source}`)}) })`;
          const en = `() => checked({ source: ${JSON.stringify(`${messages}/en.tsx`)}, load: () => import(${JSON.stringify(`/${messages}/en.tsx`)}) })`;
          const ja = `() => checked({ source: ${JSON.stringify(`${messages}/ja.tsx`)}, load: () => import(${JSON.stringify(`/${messages}/ja.tsx`)}) })`;
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
        return `import "/styles/site.css"; export { default as layout } from "/components/DocLayout.vue"; export { default as page } from ${JSON.stringify(`/${page.source}`)}; export { default as docsLink } from "/components/DocsLink.vue"; export { default as skipToContentLink } from "/components/SkipToContentLink.vue"; export { default as externalLink } from "/components/ExternalLink.vue"; export { default as appEntryLink } from "/components/AppEntryLink.vue"; export { default as uiLabel } from "/components/UiLabel.vue";`;
      }
      return undefined;
    },
    async transform(source, id, options) {
      const translation = articleTranslationFile({ root, id });
      if (translation && !options?.ssr && !allowTestArticleTranslations) throw new Error(`Docs article translations are server-only: ${translation}`);
      // These are filesystem IDs, not request URLs. Preserve drive letters,
      // spaces and literal percent signs; generated Vue subrequests have queries.
      if (id.includes('\0') || id.includes('?') || !/\.(?:vue|tsx?|jsx?)$/u.test(id)) return undefined;
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
      if (id.endsWith('.tsx')) {
        const result = await transformAsync(source, {
          filename,
          babelrc: false,
          configFile: false,
          parserOpts: { sourceType: 'module', plugins: ['typescript', 'jsx'] },
          plugins: [vueJsx],
          sourceMaps: true,
        });
        if (!result?.code) throw new Error(`Docs JSX transform produced no code: ${docsFile}`);
        return { code: result.code, map: result.map };
      }
      return undefined;
    },
  };
}
