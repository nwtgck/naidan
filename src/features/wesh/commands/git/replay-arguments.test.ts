import { describe, expect, it } from 'vitest';
import { parseReplayControlAction } from '@/features/wesh/commands/git/replay-arguments';
describe('git replay control argument parsing', () => {
  it('allows --no-edit alongside one control action in either order', () => {
    expect(parseReplayControlAction({ args: ['--continue', '--no-edit'] })).toBe('continue');
    expect(parseReplayControlAction({ args: ['--no-edit', '--continue'] })).toBe('continue');
  });
  it('rejects conflicting control actions', () => {
    expect(() => parseReplayControlAction({ args: ['--continue', '--abort'] })).toThrow("options '--continue' and '--abort' cannot be used together");
  });
  it('rejects unrelated arguments when a control action is present', () => {
    expect(() => parseReplayControlAction({ args: ['--skip', '--mainline', '1'] })).toThrow("options cannot be combined with '--skip'");
  });
  it('leaves ordinary replay arguments for the command parser', () => {
    expect(parseReplayControlAction({ args: ['--no-edit', 'HEAD'] })).toBeUndefined();
  });
});
