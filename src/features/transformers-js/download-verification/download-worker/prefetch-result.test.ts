import { describe, expect, it } from 'vitest';
import { parsePrefetchResult } from './prefetch-result';

const core = { requestedCount: 1, cachedCount: 0, downloadedCount: 1, failedCount: 0, complete: true,
  files: [{ status: 'downloaded', url: 'https://fixture.test/a', path: 'models/a', byteLength: 4, expectedByteLength: 4 }],
};
describe('prefetch core and advisory validation', () => {
  it('preserves exact core results with absent timing', () => {
    expect(parsePrefetchResult({ value: core })).toEqual(core);
  });
  it('discards invalid timing independently of a valid core success', () => {
    const result = parsePrefetchResult({ value: { ...core, timing: { callMs: NaN }, files: [{ ...core.files[0], timing: { eofToVerifiedMs: -1 } }] } });
    const { timing, files, ...rest } = result;
    const file = files[0]!;
    const { timing: fileTiming, ...fileCore } = file;
    expect({ ...rest, files: [fileCore] }).toEqual(core);
    expect(timing).toEqual({ version: 1, status: 'unavailable' });
    expect(fileTiming).toBeUndefined();
  });
  it('retains a valid direct method when optional duration is malformed', () => {
    const result = parsePrefetchResult({ value: { ...core, files: [{ ...core.files[0], timing: { version: 1, status: 'measured', saveMethod: 'direct', eofToVerifiedMs: -1 } }] } });
    const { files, ...rest } = result;
    const { timing, ...fileCore } = files[0]!;
    expect({ ...rest, files: [fileCore] }).toEqual(core);
    expect(timing).toEqual({ version: 1, status: 'unavailable', saveMethod: 'direct' });
  });
  it('still rejects malformed core data even when advisory timing is absent', () => {
    expect(() => parsePrefetchResult({ value: { ...core, files: [{ ...core.files[0], byteLength: -1 }] } })).toThrow();
  });
  it('does not accept a cached file as a measured new save', () => {
    const result = parsePrefetchResult({ value: { ...core, cachedCount: 1, downloadedCount: 0, files: [{ ...core.files[0], status: 'cached', timing: { version: 1, status: 'measured', saveMethod: 'staging-copy', eofToVerifiedMs: 10 } }] } });
    const file = result.files[0];
    expect(file?.status).toBe('cached');
    if (file?.status !== 'cached') {
      throw new Error('Expected the unchanged cached core result');
    }
    expect(file.byteLength).toBe(4);
    expect(file.timing).toEqual({ version: 1, status: 'unavailable', saveMethod: 'staging-copy' });
  });
});
