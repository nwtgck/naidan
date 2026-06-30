import type { WikipediaPageResult, WikipediaSearchGroup } from './types';

export function renderWikipediaSearchMarkdown({
  groups,
}: {
  groups: WikipediaSearchGroup[],
}): string {
  const lines = ['lang\tpageId\ttitle'];

  for (const group of groups) {
    for (const item of group.items) {
      lines.push(`${group.lang}\t${item.pageId}\t${sanitizeWikipediaSearchTsvField({ value: item.title })}`);
    }
  }

  return lines.join('\n');
}

function sanitizeWikipediaSearchTsvField({
  value,
}: {
  value: string,
}): string {
  return value.replace(/[\t\r\n]+/g, ' ');
}

export function renderWikipediaPageMarkdown({
  page,
}: {
  page: WikipediaPageResult,
}): string {
  switch (page.kind) {
  case 'inline':
    return `\
lang: ${page.lang}
pageId: ${page.pageId}
title: ${page.title}

BEGIN CONTENT
${page.content}
END CONTENT`;
  case 'binary_object':
    return `\
lang: ${page.lang}
pageId: ${page.pageId}
title: ${page.title}

Wikipedia page text was saved to sysfs Naidan:
${page.sysfsNaidanDataFilePath}

lines: ${page.lineCount}
bytes: ${page.byteLength}

Command hints for reducing context:
grep -nF -C 20 'keyword' <path>
awk 'NR>80{exit}{print NR":"$0}' <path>`;
  default: {
    const neverPage: never = page;
    throw new Error(`Unhandled Wikipedia page result: ${String(neverPage)}`);
  }
  }
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {};
