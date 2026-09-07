import { describe, expect, it } from 'vitest';
import { splitExpandedFields, type WeshExpandedFieldPart } from './field-split';

function quotedEmptyPart(): WeshExpandedFieldPart {
  return {
    text: '',
    quoted: true,
    fieldSplitEligible: false,
  };
}

function unquotedExpansionPart({ text }: { text: string }): WeshExpandedFieldPart {
  return {
    text,
    quoted: false,
    fieldSplitEligible: true,
  };
}

describe('splitExpandedFields', () => {
  it('preserves Bash empty-field boundaries around non-whitespace IFS delimiters', () => {
    expect(splitExpandedFields({
      parts: [unquotedExpansionPart({ text: '::' })],
      context: 'argv',
      ifs: ':',
    }).map((field) => field.text)).toEqual(['', '']);

    expect(splitExpandedFields({
      parts: [quotedEmptyPart(), unquotedExpansionPart({ text: '::' })],
      context: 'argv',
      ifs: ':',
    }).map((field) => field.text)).toEqual(['', '']);

    expect(splitExpandedFields({
      parts: [unquotedExpansionPart({ text: '::' }), quotedEmptyPart()],
      context: 'argv',
      ifs: ':',
    }).map((field) => field.text)).toEqual(['', '', '']);
  });

  it('splits non-BMP IFS delimiters without rebuilding non-delimiter text', () => {
    const fields = splitExpandedFields({
      parts: [
        unquotedExpansionPart({ text: 'alpha💥beta' }),
        {
          text: '💥',
          quoted: true,
          fieldSplitEligible: false,
        },
        unquotedExpansionPart({ text: 'gamma💥delta' }),
      ],
      context: 'argv',
      ifs: '💥',
    });

    expect(fields.map((field) => field.text)).toEqual([
      'alpha',
      'beta💥gamma',
      'delta',
    ]);
    expect(fields.map((field) => field.parts.map((part) => part.text))).toEqual([
      ['alpha'],
      ['beta', '💥', 'gamma'],
      ['delta'],
    ]);
  });

  it('coalesces IFS whitespace adjacent to a non-whitespace delimiter like Bash', () => {
    expect(splitExpandedFields({
      parts: [unquotedExpansionPart({ text: ' : ' })],
      context: 'argv',
      ifs: ' :',
    }).map((field) => field.text)).toEqual(['']);

    expect(splitExpandedFields({
      parts: [quotedEmptyPart(), unquotedExpansionPart({ text: ' : ' })],
      context: 'argv',
      ifs: ' :',
    }).map((field) => field.text)).toEqual(['']);
  });
});
