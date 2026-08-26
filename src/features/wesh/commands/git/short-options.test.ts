import { describe, expect, it } from 'vitest';
import { expandGitShortOptions } from '@/features/wesh/commands/git/short-options';

describe('git short option normalization', () => {
  it('expands flag clusters while preserving order', () => {
    expect(expandGitShortOptions({
      args: ['-sbz'],
      flagOptions: ['s', 'b', 'z'],
      valueOptions: [],
    })).toEqual(['-s', '-b', '-z']);
  });

  it('uses the remainder of a cluster as an attached option value', () => {
    expect(expandGitShortOptions({
      args: ['-ammessage', 'tail'],
      flagOptions: ['a'],
      valueOptions: ['m'],
    })).toEqual(['-a', '-m', 'message', 'tail']);
  });

  it('lets a final value option consume the following argv entry', () => {
    expect(expandGitShortOptions({
      args: ['-am', 'message'],
      flagOptions: ['a'],
      valueOptions: ['m'],
    })).toEqual(['-a', '-m', 'message']);
  });

  it('leaves unknown clusters intact for command-local diagnostics', () => {
    expect(expandGitShortOptions({
      args: ['-sx'],
      flagOptions: ['s'],
      valueOptions: [],
    })).toEqual(['-sx']);
  });

  it('does not parse option-looking operands after --', () => {
    expect(expandGitShortOptions({
      args: ['-s', '--', '-bz'],
      flagOptions: ['s', 'b', 'z'],
      valueOptions: [],
    })).toEqual(['-s', '--', '-bz']);
  });
});
