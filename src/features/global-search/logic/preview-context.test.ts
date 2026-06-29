import { describe, expect, it } from 'vitest';
import {
  resolveSearchPreviewContextSize,
  resolveSearchPreviewMessageWindow,
} from './preview-context';

describe('resolveSearchPreviewContextSize', () => {
  it.each([
    { input: 1, expected: 1 },
    { input: 4, expected: 4 },
    { input: 10, expected: 10 },
    { input: 4.9, expected: 4 },
    { input: 0, expected: 1 },
    { input: -3, expected: 1 },
    { input: Number.POSITIVE_INFINITY, expected: 2 },
    { input: Number.NaN, expected: 2 },
    { input: 'full' as const, expected: 'full' as const },
  ])('resolves $input to $expected', ({ input, expected }) => {
    expect(resolveSearchPreviewContextSize({ size: input })).toBe(expected);
  });
});

describe('resolveSearchPreviewMessageWindow', () => {
  it('shows the last requested number of messages for a chat title result', () => {
    expect(resolveSearchPreviewMessageWindow({
      messageCount: 5,
      matchedIndex: undefined,
      contextSize: 2,
    })).toEqual({ start: 3, end: 5 });
  });

  it('shows messages before and after a matched message', () => {
    expect(resolveSearchPreviewMessageWindow({
      messageCount: 8,
      matchedIndex: 3,
      contextSize: 2,
    })).toEqual({ start: 1, end: 6 });
  });

  it('clips the matched-message window at branch boundaries', () => {
    expect(resolveSearchPreviewMessageWindow({
      messageCount: 4,
      matchedIndex: 0,
      contextSize: 2,
    })).toEqual({ start: 0, end: 3 });
  });

  it('falls back to recent history if the matched message is unavailable', () => {
    expect(resolveSearchPreviewMessageWindow({
      messageCount: 5,
      matchedIndex: -1,
      contextSize: 2,
    })).toEqual({ start: 3, end: 5 });
  });

  it('shows the full branch for the full marker', () => {
    expect(resolveSearchPreviewMessageWindow({
      messageCount: 5,
      matchedIndex: 2,
      contextSize: 'full',
    })).toEqual({ start: 0, end: 5 });
  });
});
