import { afterEach, describe, expect, it, vi } from 'vitest';
import { reportHizoFSTrialFailure } from '@/00-storage/service/naidan-opfs/trial-debug';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('HizoFS trial debug', () => {
  it('emits a grep-stable development trace without secret material', () => {
    const failure = new TypeError('directory.stat is not a function');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    reportHizoFSTrialFailure({
      cause: failure,
      detail: {
        event: 'native_enable_failure',
        fileSystemId: 'startFailureTarget001',
        operationId: 'trial-operation',
        stage: 'advance_transition',
      },
    });

    expect(warn).toHaveBeenCalledWith('[HIZOFS_TRIAL_DEBUG_001]', {
      event: 'native_enable_failure',
      failure: {
        errorCode: undefined,
        errorMessage: 'directory.stat is not a function',
        errorName: 'TypeError',
        errorPath: undefined,
      },
      fileSystemId: 'startFailureTarget001',
      operationId: 'trial-operation',
      stage: 'advance_transition',
    });
  });
});
