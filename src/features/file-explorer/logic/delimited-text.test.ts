import { describe, expect, it } from 'vitest';
import {
  DELIMITED_TEXT_LIMITS,
  parseDelimitedText,
  replaceDelimitedTextCells,
  type DelimitedTextFormat,
} from './delimited-text';

function parse({ text, format, partial }: { text: string; format: DelimitedTextFormat; partial: boolean }) {
  const result = parseDelimitedText({ text, format, partial, limits: DELIMITED_TEXT_LIMITS.detail });
  if (result.status !== 'parsed') {
    throw new Error('Expected a parsed table');
  }
  return result;
}

describe('parseDelimitedText', () => {
  it('reads quoted multiline CSV with escaped quotes and a UTF-8 BOM', () => {
    const text = ['\uFEFFid,"text"', '001,"first, line', 'second ""quoted"" line"', ''].join('\r\n');
    const result = parse({ text, format: 'csv', partial: false });

    expect(result.truncated).toBe(false);
    expect(result.rows.map(row => row.map(cell => cell.value))).toEqual([
      ['id', 'text'],
      ['001', ['first, line', 'second "quoted" line'].join('\r\n')],
    ]);
    expect(text.slice(result.rows[0]![1]!.start, result.rows[0]![1]!.end)).toBe('"text"');
  });

  it('preserves trailing empty fields and allows a ragged TSV', () => {
    const text = ['name\t', 'one', 'two\t"left\tright"\t'].join('\n');
    const result = parse({ text, format: 'tsv', partial: false });

    expect(result.rows.map(row => row.map(cell => cell.value))).toEqual([
      ['name', ''],
      ['one'],
      ['two', 'left\tright', ''],
    ]);
  });

  it('omits a final record truncated inside a quoted field', () => {
    const partialText = ['id,note', '001,"unfinished', 'multiline'].join('\n');
    const result = parse({ text: partialText, format: 'csv', partial: true });

    expect(result.truncated).toBe(true);
    expect(result.rows.map(row => row.map(cell => cell.value))).toEqual([['id', 'note']]);
  });

  it('omits a partial final record even if its current bytes form a valid row', () => {
    const partialText = ['id,note', '001,"possibly more"'].join('\n');
    const result = parse({ text: partialText, format: 'csv', partial: true });

    expect(result.truncated).toBe(true);
    expect(result.rows).toHaveLength(1);
  });

  it('rejects a malformed complete CSV', () => {
    for (const text of ['"open', '"row"trailing,field', 'foo"bar,value']) {
      expect(parseDelimitedText({ text, format: 'csv', partial: false, limits: DELIMITED_TEXT_LIMITS.detail })).toEqual({ status: 'invalid' });
    }
  });

  it('reports omitted rows or columns and omits a record extending beyond the character budget', () => {
    const text = ['a,b,c', 'longer,row'].join('\n');
    const limits = { characters: 7, rows: 20, columns: 2 };
    const result = parseDelimitedText({ text, format: 'csv', partial: false, limits });

    expect(result.status).toBe('parsed');
    if (result.status === 'parsed') {
      expect(result.truncated).toBe(true);
      expect(result.rows.map(row => row.map(cell => cell.value))).toEqual([['a', 'b']]);
    }
  });
});

describe('replaceDelimitedTextCells', () => {
  it('rewrites only changed spans and keeps the BOM, quoting, and line endings', () => {
    const text = ['\uFEFF"001",label," note "', '"002",foo,bar', ''].join('\r\n');
    const { rows } = parse({ text, format: 'csv', partial: false });
    const changes = new Map([
      [rows[1]![1]!, 'new, "quoted"'],
      [rows[0]![2]!, 'keep quotes'],
    ]);

    expect(replaceDelimitedTextCells({ text, format: 'csv', changes })).toBe(
      ['\uFEFF"001",label,"keep quotes"', '"002","new, ""quoted""",bar', ''].join('\r\n'),
    );
  });

  it('keeps a final one-cell record when its field is cleared', () => {
    for (const prefix of ['', '\uFEFF', ['first', ''].join('\r\n')]) {
      const text = `${prefix}value`;
      const { rows } = parse({ text, format: 'csv', partial: false });
      const changes = new Map([[rows.at(-1)![0]!, '']]);

      expect(replaceDelimitedTextCells({ text, format: 'csv', changes })).toBe(`${prefix}""`);
    }
  });

  it('keeps an inserted leading marker as field data', () => {
    const text = 'name,detail';
    const { rows } = parse({ text, format: 'csv', partial: false });
    const changes = new Map([[rows[0]![0]!, '\uFEFFvalue']]);

    expect(replaceDelimitedTextCells({ text, format: 'csv', changes })).toBe('"\uFEFFvalue",detail');
  });
});
