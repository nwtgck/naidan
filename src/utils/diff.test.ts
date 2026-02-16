import { describe, it, expect } from 'vitest';
import { computeWordDiff } from './diff';

describe('computeWordDiff', () => {
  it('returns a single unchanged part for identical strings', () => {
    const text = 'Hello world';
    const result = computeWordDiff({ oldText: text, newText: text });
    expect(result).toEqual([{ type: 'unchanged', value: text }]);
  });

  it('detects simple additions', () => {
    const oldText = 'Hello';
    const newText = 'Hello world';
    const result = computeWordDiff({ oldText, newText });
    expect(result).toEqual([
      { type: 'unchanged', value: 'Hello' },
      { type: 'added', value: ' world' },
    ]);
  });

  it('detects simple removals', () => {
    const oldText = 'Hello world';
    const newText = 'Hello';
    const result = computeWordDiff({ oldText, newText });
    expect(result).toEqual([
      { type: 'unchanged', value: 'Hello' },
      { type: 'removed', value: ' world' },
    ]);
  });

  it('detects replacements within a sentence', () => {
    const oldText = 'The quick brown fox';
    const newText = 'The fast brown fox';
    const result = computeWordDiff({ oldText, newText });
    expect(result).toEqual([
      { type: 'unchanged', value: 'The ' },
      { type: 'removed', value: 'quick' },
      { type: 'added', value: 'fast' },
      { type: 'unchanged', value: ' brown fox' },
    ]);
  });

  it('handles symbols as separate tokens', () => {
    const oldText = 'Hello, world!';
    const newText = 'Hello world.';
    const result = computeWordDiff({ oldText, newText });

    // With symbol-aware tokenization:
    // "Hello", ",", " ", "world", "!"
    // "Hello", " ", "world", "."
    expect(result).toEqual([
      { type: 'unchanged', value: 'Hello' },
      { type: 'removed', value: ',' },
      { type: 'unchanged', value: ' world' },
      { type: 'removed', value: '!' },
      { type: 'added', value: '.' },
    ]);
  });

  it('handles whitespace changes correctly', () => {
    const oldText = 'A  B';
    const newText = 'A B';
    const result = computeWordDiff({ oldText, newText });
    expect(result).toEqual([
      { type: 'unchanged', value: 'A' },
      { type: 'removed', value: '  ' },
      { type: 'added', value: ' ' },
      { type: 'unchanged', value: 'B' },
    ]);
  });

  it('handles multiple changes across multiple lines', () => {
    const oldText = 'Line 1\nLine 2\nLine 3';
    const newText = 'Line 1\nLine 2 modified\nLine 3';
    const result = computeWordDiff({ oldText, newText });
    expect(result).toEqual([
      { type: 'unchanged', value: 'Line 1\nLine 2' },
      { type: 'added', value: ' modified' },
      { type: 'unchanged', value: '\nLine 3' },
    ]);
  });
});
