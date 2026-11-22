export type DelimitedTextFormat = 'csv' | 'tsv';

export interface DelimitedTextCell {
  readonly start: number;
  readonly end: number;
  readonly value: string;
  readonly quoted: boolean;
}

type DelimitedTextLimits = {
  readonly characters: number;
  readonly rows: number;
  readonly columns: number;
};

export const DELIMITED_TEXT_LIMITS = {
  preview: { characters: 64 * 1024, rows: 20, columns: 12 },
  detail: { characters: 2 * 1024 * 1024, rows: 1000, columns: 64 },
} satisfies Record<'preview' | 'detail', DelimitedTextLimits>;

type DelimitedTextResult =
  | { status: 'parsed'; rows: DelimitedTextCell[][]; truncated: boolean }
  | { status: 'invalid' };

type ParsedField = { end: number; quoted: boolean } | 'incomplete' | 'invalid';

function getDelimiter({ format }: { format: DelimitedTextFormat }): string {
  switch (format) {
  case 'csv': return ',';
  case 'tsv': return '\t';
  default: {
    const exhaustive: never = format;
    throw new Error(`Unsupported delimited text format: ${exhaustive}`);
  }
  }
}

function isFieldBoundary({ character, delimiter }: { character: string | undefined; delimiter: string }): boolean {
  return character === delimiter || character === '\r' || character === '\n';
}

function readQuotedField({ text, start, limit, delimiter, partial }: {
  text: string;
  start: number;
  limit: number;
  delimiter: string;
  partial: boolean;
}): ParsedField {
  let cursor = start + 1;
  while (cursor < limit) {
    if (text[cursor] !== '"') {
      cursor += 1;
      continue;
    }
    const next = cursor + 1;
    if (next === limit) {
      return partial ? 'incomplete' : { end: next, quoted: true };
    }
    const following = text[next];
    if (following === '"') {
      cursor = next + 1;
      continue;
    }
    return isFieldBoundary({ character: following, delimiter }) ? { end: next, quoted: true } : 'invalid';
  }
  return partial ? 'incomplete' : 'invalid';
}

function readField({ text, start, limit, delimiter, partial }: {
  text: string;
  start: number;
  limit: number;
  delimiter: string;
  partial: boolean;
}): ParsedField {
  if (text[start] === '"') {
    return readQuotedField({ text, start, limit, delimiter, partial });
  }

  let end = start;
  while (end < limit && !isFieldBoundary({ character: text[end], delimiter })) {
    if (text[end] === '"') {
      return 'invalid';
    }
    end += 1;
  }
  return end === limit && partial ? 'incomplete' : { end, quoted: false };
}

export function parseDelimitedText({ text, format, partial, limits }: {
  text: string;
  format: DelimitedTextFormat;
  partial: boolean;
  limits: DelimitedTextLimits;
}): DelimitedTextResult {
  const delimiter = getDelimiter({ format });
  const limit = Math.min(text.length, limits.characters);
  const incompleteInput = partial || limit < text.length;
  let truncated = incompleteInput;
  const rows: DelimitedTextCell[][] = [];
  let start = text.startsWith('\uFEFF') ? 1 : 0;

  while (start < limit && rows.length < limits.rows) {
    const row: DelimitedTextCell[] = [];
    for (;;) {
      const field = readField({ text, start, limit, delimiter, partial: incompleteInput });
      if (field === 'invalid') {
        return { status: 'invalid' };
      }
      if (field === 'incomplete') {
        return { status: 'parsed', rows, truncated: true };
      }

      const { end, quoted } = field;
      if (row.length < limits.columns) {
        const value = quoted ? text.slice(start + 1, end - 1).replaceAll('""', '"') : text.slice(start, end);
        row.push({ start, end, value, quoted });
      } else {
        truncated = true;
      }

      if (end === limit) {
        start = end;
        break;
      }
      if (text[end] !== delimiter) {
        start = text[end] === '\r' && end + 1 < limit && text[end + 1] === '\n' ? end + 2 : end + 1;
        break;
      }
      start = end + 1;
    }
    rows.push(row);
  }

  return { status: 'parsed', rows, truncated: truncated || start < limit };
}

export function replaceDelimitedTextCells({ text, format, changes }: {
  text: string;
  format: DelimitedTextFormat;
  changes: ReadonlyMap<DelimitedTextCell, string>;
}): string {
  const delimiter = getDelimiter({ format });
  const replacements = [...changes].sort(([left], [right]) => left.start - right.start);
  const parts: string[] = [];
  const startOfText = text.startsWith('\uFEFF') ? 1 : 0;
  let cursor = 0;
  for (const [cell, value] of replacements) {
    if (value === cell.value) {
      continue;
    }
    // A final one-cell record must survive clearing its only field.
    const previousCharacter = text[cell.start - 1];
    const isEmptyFinalRecord = value === '' &&
      cell.end === text.length &&
      (cell.start === startOfText || previousCharacter === '\n' || previousCharacter === '\r');
    const startsWithBom = cell.start === 0 && value.startsWith('\uFEFF');
    const quoted = cell.quoted || isEmptyFinalRecord || startsWithBom || value.includes(delimiter) || /["\r\n]/.test(value);
    parts.push(text.slice(cursor, cell.start), quoted ? `"${value.replaceAll('"', '""')}"` : value);
    cursor = cell.end;
  }
  parts.push(text.slice(cursor));
  return parts.join('');
}

export const TEST_ONLY = {
};
