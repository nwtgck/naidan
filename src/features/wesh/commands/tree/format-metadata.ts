import type { TreeEntryInfo, TreeOptions, TreeRenderNode } from './types';

function fileTypeChar({ type }: { type: TreeEntryInfo['displayType'] }): string {
  switch (type) {
  case 'directory':
    return 'd';
  case 'symlink':
    return 'l';
  case 'fifo':
    return 'p';
  case 'chardev':
    return 'c';
  case 'file':
    return '-';
  default: {
    const _ex: never = type;
    throw new Error(`Unhandled file type: ${_ex}`);
  }
  }
}

function rwx({ mode, bit, char }: { mode: number, bit: number, char: string }): string {
  return (mode & bit) === bit ? char : '-';
}

export function formatPermissions({ info }: { info: TreeEntryInfo }): string {
  const mode = info.stat.mode;
  return [
    fileTypeChar({ type: info.displayType }),
    rwx({ mode, bit: 0o400, char: 'r' }),
    rwx({ mode, bit: 0o200, char: 'w' }),
    rwx({ mode, bit: 0o100, char: 'x' }),
    rwx({ mode, bit: 0o040, char: 'r' }),
    rwx({ mode, bit: 0o020, char: 'w' }),
    rwx({ mode, bit: 0o010, char: 'x' }),
    rwx({ mode, bit: 0o004, char: 'r' }),
    rwx({ mode, bit: 0o002, char: 'w' }),
    rwx({ mode, bit: 0o001, char: 'x' }),
  ].join('');
}

export function formatTreeSize({
  size,
  mode,
}: {
  size: number,
  mode: TreeOptions['showSize'],
}): string | undefined {
  switch (mode) {
  case 'none':
    return undefined;
  case 'bytes':
    return String(size);
  case 'human-1024':
    return formatHumanSize({ size, base: 1024 });
  case 'human-1000':
    return formatHumanSize({ size, base: 1000 });
  default: {
    const _ex: never = mode;
    throw new Error(`Unhandled size mode: ${_ex}`);
  }
  }
}

function formatHumanSize({ size, base }: { size: number, base: 1000 | 1024 }): string {
  const suffixes = ['', 'K', 'M', 'G', 'T', 'P'];
  let value = size;
  let suffixIndex = 0;
  while (Math.abs(value) >= base && suffixIndex < suffixes.length - 1) {
    value /= base;
    suffixIndex += 1;
  }
  if (suffixIndex === 0) {
    return String(size);
  }
  const rounded = value >= 10 ? value.toFixed(0) : value.toFixed(1);
  return `${rounded}${suffixes[suffixIndex]}`;
}

function formatDate({ mtime }: { mtime: number }): string {
  const date = new Date(mtime);
  if (Number.isNaN(date.getTime())) {
    return 'Invalid-Date';
  }
  return date.toISOString().slice(0, 16).replace('T', ' ');
}

export function formatMetadataPrefix({
  node,
  options,
}: {
  node: TreeRenderNode,
  options: TreeOptions,
}): string {
  const parts: string[] = [];
  if (options.showPermissions) {
    parts.push(formatPermissions({ info: node.info }));
  }
  if (options.showUid) {
    parts.push(String(node.info.stat.uid));
  }
  if (options.showGid) {
    parts.push(String(node.info.stat.gid));
  }
  const size = formatTreeSize({
    size: options.showDiskUsage ? node.diskUsageSize : node.info.stat.size,
    mode: options.showSize,
  });
  if (size !== undefined) {
    parts.push(size);
  }
  if (options.showDate) {
    parts.push(formatDate({ mtime: node.info.stat.mtime }));
  }
  if (options.showInodes) {
    parts.push(String(node.info.stat.ino));
  }
  if (parts.length === 0) {
    return '';
  }
  return `[${parts.join(' ')}] `;
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
  formatPermissions,
  formatTreeSize,
};
