import type { Inline, MarkdownBlock } from '@/features/fake-lm/core/markdownTypes';

export function renderMarkdownBlock({ block }: {
  block: MarkdownBlock,
}): string {
  switch (block.kind) {
  case 'heading':
    return `${'#'.repeat(block.level)} ${renderInline({ inlines: block.content })}`;
  case 'paragraph':
    return renderInline({ inlines: block.content });
  case 'list':
    return block.items
      .map((item) => `- ${renderInline({ inlines: item })}`)
      .join('\n');
  case 'table':
    return renderTable({ block });
  default: {
    const _ex: never = block;
    throw new Error(`Unhandled markdown block: ${String(_ex)}`);
  }
  }
}

export function renderInline({ inlines }: {
  inlines: Inline[],
}): string {
  return inlines.map((inline) => {
    switch (inline.kind) {
    case 'text':
      return inline.text;
    case 'bold':
      return `**${escapeBoldText({ text: inline.text })}**`;
    default: {
      const _ex: never = inline;
      throw new Error(`Unhandled inline node: ${String(_ex)}`);
    }
    }
  }).join('');
}

function renderTable({ block }: {
  block: Extract<MarkdownBlock, { kind: 'table' }>,
}): string {
  const header = block.headers.map((cell) => renderTableCell({ inlines: cell })).join(' | ');
  const separator = block.headers.map(() => '---').join(' | ');
  const rows = block.rows.map((row) => row.map((cell) => renderTableCell({ inlines: cell })).join(' | '));

  return [
    `| ${header} |`,
    `| ${separator} |`,
    ...rows.map((row) => `| ${row} |`),
  ].join('\n');
}

function renderTableCell({ inlines }: {
  inlines: Inline[],
}): string {
  return renderInline({ inlines })
    .replace(/\|/gu, '\\|')
    .replace(/\n/gu, ' ')
    .replace(/\r/gu, ' ')
    .trim();
}

function escapeBoldText({ text }: {
  text: string,
}): string {
  return text.replace(/\*/gu, '');
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {};
