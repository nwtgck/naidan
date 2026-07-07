import type { TreeEntryInfo, TreeOptions } from './types';

type VersionToken =
  | { kind: 'number', value: string }
  | { kind: 'text', value: string };

function tokenizeVersion({ value }: { value: string }): VersionToken[] {
  const tokens: VersionToken[] = [];
  let index = 0;
  while (index < value.length) {
    const char = value[index];
    if (char === undefined) {
      break;
    }
    const isDigit = /\d/.test(char);
    let end = index + 1;
    while (end < value.length && /\d/.test(value[end] ?? '') === isDigit) {
      end += 1;
    }
    tokens.push({
      kind: isDigit ? 'number' : 'text',
      value: value.slice(index, end),
    });
    index = end;
  }
  return tokens;
}

export function compareVersionNames({ left, right }: { left: string, right: string }): number {
  const leftTokens = tokenizeVersion({ value: left });
  const rightTokens = tokenizeVersion({ value: right });
  const length = Math.max(leftTokens.length, rightTokens.length);
  for (let index = 0; index < length; index += 1) {
    const leftToken = leftTokens[index];
    const rightToken = rightTokens[index];
    if (leftToken === undefined) {
      return -1;
    }
    if (rightToken === undefined) {
      return 1;
    }
    switch (leftToken.kind) {
    case 'number': {
      switch (rightToken.kind) {
      case 'number':
        break;
      case 'text':
        return -1;
      default: {
        const _ex: never = rightToken;
        throw new Error(`Unhandled version token: ${JSON.stringify(_ex)}`);
      }
      }
      const leftNormalized = leftToken.value.replace(/^0+/, '') || '0';
      const rightNormalized = rightToken.value.replace(/^0+/, '') || '0';
      if (leftNormalized.length !== rightNormalized.length) {
        return leftNormalized.length - rightNormalized.length;
      }
      const numeric = leftNormalized.localeCompare(rightNormalized);
      if (numeric !== 0) {
        return numeric;
      }
      if (leftToken.value.length !== rightToken.value.length) {
        return leftToken.value.length - rightToken.value.length;
      }
      continue;
    }
    case 'text': {
      switch (rightToken.kind) {
      case 'text':
        break;
      case 'number':
        return 1;
      default: {
        const _ex: never = rightToken;
        throw new Error(`Unhandled version token: ${JSON.stringify(_ex)}`);
      }
      }
      const text = leftToken.value.localeCompare(rightToken.value);
      if (text !== 0) {
        return text;
      }
      continue;
    }
    default: {
      const _ex: never = leftToken;
      throw new Error(`Unhandled version token: ${JSON.stringify(_ex)}`);
    }
    }
  }
  return left.localeCompare(right);
}

function typeRank({ info, options }: { info: TreeEntryInfo, options: TreeOptions }): number {
  const isDirectory = info.displayType === 'directory';
  switch (options.groupingMode) {
  case 'mixed':
    return 0;
  case 'directories-first':
    return isDirectory ? 0 : 1;
  case 'files-first':
    return isDirectory ? 1 : 0;
  default: {
    const _ex: never = options.groupingMode;
    throw new Error(`Unhandled grouping mode: ${_ex}`);
  }
  }
}

function primaryComparison({ left, right, options }: {
  left: TreeEntryInfo,
  right: TreeEntryInfo,
  options: TreeOptions,
}): number {
  switch (options.sortMode) {
  case 'none':
    return 0;
  case 'name':
    return left.name.localeCompare(right.name);
  case 'version':
    return compareVersionNames({ left: left.name, right: right.name });
  case 'mtime':
    return right.stat.mtime - left.stat.mtime;
  case 'size':
    return right.stat.size - left.stat.size;
  default: {
    const _ex: never = options.sortMode;
    throw new Error(`Unhandled sort mode: ${_ex}`);
  }
  }
}

export function sortTreeEntries({
  entries,
  options,
}: {
  entries: TreeEntryInfo[],
  options: TreeOptions,
}): TreeEntryInfo[] {
  const sorted = [...entries];
  sorted.sort((left, right) => {
    const grouping = typeRank({ info: left, options }) - typeRank({ info: right, options });
    if (grouping !== 0) {
      return grouping;
    }
    const primary = primaryComparison({ left, right, options });
    if (primary !== 0) {
      return options.reverse ? -primary : primary;
    }
    return left.originalIndex - right.originalIndex;
  });
  return sorted;
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
  compareVersionNames,
  sortTreeEntries,
};
