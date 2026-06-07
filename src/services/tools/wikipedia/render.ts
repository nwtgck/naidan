import type { WikipediaPageResult, WikipediaSearchGroup } from './types';

export function renderWikipediaSearchMarkdown({
  groups,
}: {
  groups: WikipediaSearchGroup[];
}): string {
  return groups.map((group) => {
    const lines = [`lang: ${group.lang}`, ''];
    if (group.items.length === 0) {
      lines.push('No results.');
      return lines.join('\n');
    }

    group.items.forEach((item, index) => {
      lines.push(`${index + 1}. title: ${item.title}`);
      lines.push(`   pageId: ${item.pageId}`);
      if (index < group.items.length - 1) {
        lines.push('');
      }
    });

    return lines.join('\n');
  }).join('\n\n');
}

export function renderWikipediaPageMarkdown({
  page,
}: {
  page: WikipediaPageResult;
}): string {
  switch (page.kind) {
  case 'inline':
    return `\
lang: ${page.lang}
pageId: ${page.pageId}
title: ${page.title}

BEGIN CONTENT
${page.content}
END CONTENT`
  case 'binary_object':
    return `\
lang: ${page.lang}
pageId: ${page.pageId}
title: ${page.title}

Wikipedia page text was saved to sysfs Naidan:
${page.sysfsNaidanDataFilePath}

lines: ${page.lineCount}
bytes: ${page.byteLength}`
  default: {
    const neverPage: never = page
    throw new Error(`Unhandled Wikipedia page result: ${String(neverPage)}`)
  }
  }
}
