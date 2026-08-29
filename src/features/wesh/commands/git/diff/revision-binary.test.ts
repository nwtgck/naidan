import { describe, expect, it } from 'vitest';
import { TEST_ONLY } from '@/features/wesh/commands/git/diff/revision';

const { isGitBinaryContent } = TEST_ONLY;

describe('wesh git revision binary detection', () => {
  it('checks only the first 8000 bytes like Git binary probing', () => {
    const atLastProbedByte = new Uint8Array(8001).fill(0x61);
    atLastProbedByte[7999] = 0;
    expect(isGitBinaryContent({ bytes: atLastProbedByte })).toBe(true);

    const afterProbeWindow = new Uint8Array(8001).fill(0x61);
    afterProbeWindow[8000] = 0;
    expect(isGitBinaryContent({ bytes: afterProbeWindow })).toBe(false);
  });
});
