export type GrepColorMode = 'always' | 'never';

export type GrepColorCapability =
  | 'selectedMatch'
  | 'contextMatch'
  | 'selectedLine'
  | 'contextLine'
  | 'filename'
  | 'lineNumber'
  | 'byteOffset'
  | 'separator';

export interface GrepColorPalette {
  readonly selectedMatch: string;
  readonly contextMatch: string;
  readonly selectedLine: string;
  readonly contextLine: string;
  readonly filename: string;
  readonly lineNumber: string;
  readonly byteOffset: string;
  readonly separator: string;
  readonly reverseSelectedAndContextLine: boolean;
  readonly eraseToEndOfLine: boolean;
}

const DEFAULT_GREP_COLOR_PALETTE: GrepColorPalette = {
  selectedMatch: '01;31',
  contextMatch: '01;31',
  selectedLine: '',
  contextLine: '',
  filename: '35',
  lineNumber: '32',
  byteOffset: '32',
  separator: '36',
  reverseSelectedAndContextLine: false,
  eraseToEndOfLine: true,
};

function splitGrepColors({ value }: { value: string }): readonly string[] {
  const values: string[] = [];
  let current = '';
  let escaped = false;
  for (const character of value) {
    if (escaped) {
      current += character;
      escaped = false;
      continue;
    }
    if (character === '\\') {
      escaped = true;
      continue;
    }
    if (character === ':') {
      values.push(current);
      current = '';
      continue;
    }
    current += character;
  }
  if (escaped) {
    current += '\\';
  }
  values.push(current);
  return values;
}

export function resolveGrepColorPalette({
  grepColors,
  deprecatedGrepColor,
}: {
  grepColors: string | undefined,
  deprecatedGrepColor: string | undefined,
}): {
  readonly palette: GrepColorPalette,
  readonly shouldWarnAboutDeprecatedGrepColor: boolean,
} {
  let selectedMatch = DEFAULT_GREP_COLOR_PALETTE.selectedMatch;
  let contextMatch = DEFAULT_GREP_COLOR_PALETTE.contextMatch;
  let selectedLine = DEFAULT_GREP_COLOR_PALETTE.selectedLine;
  let contextLine = DEFAULT_GREP_COLOR_PALETTE.contextLine;
  let filename = DEFAULT_GREP_COLOR_PALETTE.filename;
  let lineNumber = DEFAULT_GREP_COLOR_PALETTE.lineNumber;
  let byteOffset = DEFAULT_GREP_COLOR_PALETTE.byteOffset;
  let separator = DEFAULT_GREP_COLOR_PALETTE.separator;
  let reverseSelectedAndContextLine = DEFAULT_GREP_COLOR_PALETTE.reverseSelectedAndContextLine;
  let eraseToEndOfLine = DEFAULT_GREP_COLOR_PALETTE.eraseToEndOfLine;

  const shouldWarnAboutDeprecatedGrepColor = grepColors === undefined
    && deprecatedGrepColor !== undefined;
  if (shouldWarnAboutDeprecatedGrepColor) {
    selectedMatch = deprecatedGrepColor!;
    contextMatch = deprecatedGrepColor!;
  }

  if (grepColors !== undefined && grepColors.length > 0) {
    for (const item of splitGrepColors({ value: grepColors })) {
      if (item === 'rv') {
        reverseSelectedAndContextLine = true;
        continue;
      }
      if (item === 'ne') {
        eraseToEndOfLine = false;
        continue;
      }
      const equalsIndex = item.indexOf('=');
      if (equalsIndex < 0) {
        continue;
      }
      const key = item.slice(0, equalsIndex);
      const value = item.slice(equalsIndex + 1);
      switch (key) {
      case 'mt':
        selectedMatch = value;
        contextMatch = value;
        break;
      case 'ms':
        selectedMatch = value;
        break;
      case 'mc':
        contextMatch = value;
        break;
      case 'sl':
        selectedLine = value;
        break;
      case 'cx':
        contextLine = value;
        break;
      case 'fn':
        filename = value;
        break;
      case 'ln':
        lineNumber = value;
        break;
      case 'bn':
        byteOffset = value;
        break;
      case 'se':
        separator = value;
        break;
      default:
        break;
      }
    }
  }

  return {
    palette: {
      selectedMatch,
      contextMatch,
      selectedLine,
      contextLine,
      filename,
      lineNumber,
      byteOffset,
      separator,
      reverseSelectedAndContextLine,
      eraseToEndOfLine,
    },
    shouldWarnAboutDeprecatedGrepColor,
  };
}

function eraseSequence({ palette }: { palette: GrepColorPalette }): string {
  return palette.eraseToEndOfLine ? '\u001b[K' : '';
}

export function beginGrepColor({
  palette,
  capability,
}: {
  palette: GrepColorPalette,
  capability: GrepColorCapability,
}): string {
  const value = palette[capability];
  return value.length === 0 ? '' : `\u001b[${value}m${eraseSequence({ palette })}`;
}

export function endGrepColor({ palette }: { palette: GrepColorPalette }): string {
  return `\u001b[m${eraseSequence({ palette })}`;
}

export function colorizeGrepText({
  text,
  palette,
  capability,
}: {
  text: string,
  palette: GrepColorPalette,
  capability: GrepColorCapability,
}): string {
  const begin = beginGrepColor({ palette, capability });
  return begin.length === 0 ? text : `${begin}${text}${endGrepColor({ palette })}`;
}

export function resolveGrepLineColorCapability({
  selected,
  invertMatch,
  palette,
}: {
  selected: boolean,
  invertMatch: boolean,
  palette: GrepColorPalette,
}): Extract<GrepColorCapability, 'selectedLine' | 'contextLine'> {
  const reverse = invertMatch && palette.reverseSelectedAndContextLine;
  if (selected) {
    return reverse ? 'contextLine' : 'selectedLine';
  }
  return reverse ? 'selectedLine' : 'contextLine';
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
