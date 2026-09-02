import { describe, expect, it } from 'vitest';
import { parseReplayArguments, parseReplayControlAction } from '@/features/wesh/commands/git/replay-arguments';

describe('git replay control argument parsing', () => {
  it('allows --no-edit alongside one control action in either order', () => {
    expect(parseReplayControlAction({ args: ['--continue', '--no-edit'] })).toBe('continue');
    expect(parseReplayControlAction({ args: ['--no-edit', '--continue'] })).toBe('continue');
  });

  it('rejects conflicting control actions', () => {
    expect(() => parseReplayControlAction({ args: ['--continue', '--abort'] })).toThrow(
      "options '--abort' and '--continue' cannot be used together",
    );
  });

  it('rejects unrelated arguments when a control action is present', () => {
    expect(() => parseReplayControlAction({ args: ['--skip', '--mainline', '1'] })).toThrow(
      "options cannot be combined with '--skip'",
    );
  });

  it('leaves ordinary replay arguments for the command parser', () => {
    expect(parseReplayControlAction({ args: ['--no-edit', 'HEAD'] })).toBeUndefined();
  });
});

describe('git replay start argument parsing', () => {
  it('shares short mainline parsing across cherry-pick and revert', () => {
    for (const kind of ['cherry-pick', 'revert'] as const) {
      expect(parseReplayArguments({ args: ['-m2', 'HEAD'], kind })).toEqual({
        action: 'start',
        operands: ['HEAD'],
        mainlineParentNumber: 2,
      });
      expect(parseReplayArguments({ args: ['-m', '2', 'HEAD'], kind })).toEqual({
        action: 'start',
        operands: ['HEAD'],
        mainlineParentNumber: 2,
      });
    }
  });

  it('keeps replay long options exact-only like Linux Git', () => {
    for (const kind of ['cherry-pick', 'revert'] as const) {
      expect(() => parseReplayArguments({ args: ['--no-e', 'HEAD'], kind })).toThrow(
        `unsupported ${kind} option: --no-e`,
      );
      expect(() => parseReplayArguments({ args: ['--mai=2', 'HEAD'], kind })).toThrow(
        `unsupported ${kind} option: --mai=2`,
      );
    }
  });

  it('keeps exact --mainline attached and following-value parsing', () => {
    for (const kind of ['cherry-pick', 'revert'] as const) {
      expect(parseReplayArguments({ args: ['--mainline', '2', 'HEAD'], kind })).toEqual({
        action: 'start',
        operands: ['HEAD'],
        mainlineParentNumber: 2,
      });
      expect(parseReplayArguments({ args: ['--mainline=2', 'HEAD'], kind })).toEqual({
        action: 'start',
        operands: ['HEAD'],
        mainlineParentNumber: 2,
      });
    }
  });

  it('keeps option parsing active after ordinary operands until --', () => {
    for (const kind of ['cherry-pick', 'revert'] as const) {
      expect(parseReplayArguments({ args: ['HEAD', '--no-edit'], kind })).toEqual({
        action: 'start',
        operands: ['HEAD'],
        mainlineParentNumber: undefined,
      });
      expect(parseReplayArguments({ args: ['--', 'HEAD', '--no-edit'], kind })).toEqual({
        action: 'start',
        operands: ['HEAD', '--no-edit'],
        mainlineParentNumber: undefined,
      });
    }
  });
});
