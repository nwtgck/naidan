import type { TreeEntryInfo, TreeNameDisplayMode, TreeOptions } from './types';

function isPrintable({ char }: { char: string }): boolean {
  const code = char.codePointAt(0) ?? 0;
  return code >= 0x20 && code !== 0x7f;
}

function escapeChar({ char }: { char: string }): string {
  switch (char) {
  case '\\':
    return '\\\\';
  case '\n':
    return '\\n';
  case '\r':
    return '\\r';
  case '\t':
    return '\\t';
  case '\b':
    return '\\b';
  case '\f':
    return '\\f';
  case ' ':
    return '\\ ';
  default: {
    if (isPrintable({ char })) {
      return char;
    }
    const code = char.codePointAt(0) ?? 0;
    return `\\x${code.toString(16).padStart(2, '0')}`;
  }
  }
}

function renderNameBody({
  value,
  mode,
}: {
  value: string,
  mode: TreeNameDisplayMode,
}): string {
  switch (mode) {
  case 'literal':
    return value;
  case 'question':
    return Array.from(value).map((char) => isPrintable({ char }) ? char : '?').join('');
  case 'escaped':
    return Array.from(value).map((char) => escapeChar({ char })).join('');
  default: {
    const _ex: never = mode;
    throw new Error(`Unhandled name display mode: ${_ex}`);
  }
  }
}

function maybeQuote({
  value,
  quote,
}: {
  value: string,
  quote: boolean,
}): string {
  if (!quote) {
    return value;
  }
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

export function renderFileName({
  value,
  options,
}: {
  value: string,
  options: TreeOptions,
}): string {
  return maybeQuote({
    value: renderNameBody({ value, mode: options.nameDisplayMode }),
    quote: options.quoteNames,
  });
}

function classifySuffix({ info }: { info: TreeEntryInfo }): string {
  switch (info.displayType) {
  case 'directory':
    return '/';
  case 'symlink':
    return '@';
  case 'fifo':
    return '|';
  case 'file':
  case 'chardev':
    return '';
  default: {
    const _ex: never = info.displayType;
    throw new Error(`Unhandled file type: ${_ex}`);
  }
  }
}

export function renderTreeEntryName({
  info,
  options,
}: {
  info: TreeEntryInfo,
  options: TreeOptions,
}): string {
  const name = renderFileName({ value: info.displayPath, options });
  const suffix = options.classify ? classifySuffix({ info }) : '';
  if (info.linkTarget === undefined) {
    return `${name}${suffix}`;
  }
  return `${name}${suffix} -> ${renderFileName({ value: info.linkTarget, options })}`;
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
  renderFileName,
};
