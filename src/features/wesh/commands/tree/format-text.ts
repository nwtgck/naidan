import { formatMetadataPrefix } from './format-metadata';
import { renderTreeEntryName } from './format-name';
import type { TreeOptions, TreeRenderNode, TreeSummary } from './types';

export function childPrefix({
  options,
  ancestorHasMoreSiblings,
  isLast,
}: {
  options: TreeOptions,
  ancestorHasMoreSiblings: boolean[],
  isLast: boolean,
}): string {
  switch (options.indentMode) {
  case 'none':
    return '';
  case 'tree':
    break;
  default: {
    const _ex: never = options.indentMode;
    throw new Error(`Unhandled indent mode: ${_ex}`);
  }
  }
  const { trunk, branch } = (() => {
    switch (options.charset) {
    case 'ascii':
      return { trunk: '|   ', branch: isLast ? '`-- ' : '|-- ' };
    case 'utf8':
      return { trunk: '│   ', branch: isLast ? '└── ' : '├── ' };
    default: {
      const _ex: never = options.charset;
      throw new Error(`Unhandled charset: ${_ex}`);
    }
    }
  })();
  const blank = '    ';
  return `${ancestorHasMoreSiblings.map((hasMore) => hasMore ? trunk : blank).join('')}${branch}`;
}

export function renderTreeLine({
  node,
  options,
  prefix,
}: {
  node: TreeRenderNode,
  options: TreeOptions,
  prefix: string,
}): string {
  const recursion = node.recursiveLink ? '  [recursive, not followed]' : '';
  const fileLimit = node.fileLimitExceeded ? '  [file limit exceeded]' : '';
  const readError = node.readError === undefined ? '' : `  [error opening dir: ${node.readError}]`;
  return `${prefix}${formatMetadataPrefix({ node, options })}${renderTreeEntryName({ info: node.info, options })}${recursion}${fileLimit}${readError}\n`;
}

export function renderSummary({
  summary,
  options,
}: {
  summary: TreeSummary,
  options: TreeOptions,
}): string {
  if (options.showDiskUsage) {
    return `${summary.bytesUsed} bytes used in ${summary.directories} ${summary.directories === 1 ? 'directory' : 'directories'}, ${summary.files} ${summary.files === 1 ? 'file' : 'files'}\n`;
  }
  return `${summary.directories} ${summary.directories === 1 ? 'directory' : 'directories'}, ${summary.files} ${summary.files === 1 ? 'file' : 'files'}\n`;
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
  childPrefix,
  renderTreeLine,
  renderSummary,
};
