import { describe, expect, it } from 'vitest';
import { parsePortableFileSystemId } from '@/00-storage/service/hizofs/compatibility';
import { parseTransitionOperationId } from '@/00-storage/service/naidan-persistence-control/00-format';
import {
  decodeTransitionRuntimeProgress,
  encodeTransitionRuntimeProgress,
} from '@/00-storage/service/naidan-persistence-control/transition/transition-runtime-progress-codec';
import type { TransitionRuntimeProgress } from '@/00-storage/service/naidan-persistence-control/transition/transition-coordinator';

const OPERATION = parseTransitionOperationId({ value: 'transition_0123456789' });
const SOURCE = { type: 'plain' } as const;
const TARGET = { fileSystemId: parsePortableFileSystemId({ value: '0123456789_ABCDEFGHIJ' }), type: 'hizofs' } as const;

function copying(): TransitionRuntimeProgress {
  return {
    copyCursor: {
      activeFile: {
        metadata: { createdAt: undefined, modifiedAt: -7n },
        offset: 3n,
        path: ['nested', '日本語.bin'],
        size: 9n,
      },
      completedBytes: 11n,
      completedEntries: 2n,
      directories: [
        { afterName: undefined, path: [] },
        { afterName: '日本語.bin', path: ['nested'] },
      ],
      state: 'copying',
    },
    operationId: OPERATION,
    source: SOURCE,
    sourceAuthorityIdentity: 'source-v1',
    stage: 'copying',
    target: TARGET,
  };
}

describe('transition runtime progress codec', () => {
  it('round-trips copying progress without losing bigint, absent timestamps, or traversal state', () => {
    const encoded = encodeTransitionRuntimeProgress({ progress: copying() });
    expect(decodeTransitionRuntimeProgress({ bytes: encoded })).toEqual(copying());
    expect(new TextDecoder().decode(encoded)).toContain('"createdAt":"","modifiedAt":"-7"');
  });

  it('round-trips verifying progress with a complete cursor', () => {
    const progress: TransitionRuntimeProgress = {
      operationId: OPERATION,
      source: SOURCE,
      sourceAuthorityIdentity: 'source-v1',
      stage: 'verifying',
      target: TARGET,
      verificationCursor: {
        activeFile: undefined,
        directories: [],
        state: 'complete',
        verifiedBytes: 17n,
        verifiedEntries: 5n,
      },
    };
    expect(decodeTransitionRuntimeProgress({ bytes: encodeTransitionRuntimeProgress({ progress }) })).toEqual(progress);
  });

  it('rejects non-canonical field order and malformed cursor invariants', () => {
    const encoded = new TextDecoder().decode(encodeTransitionRuntimeProgress({ progress: copying() }));
    expect(() => decodeTransitionRuntimeProgress({
      bytes: new TextEncoder().encode(encoded.replace('"operationId"', '"zOperationId"')),
    })).toThrow(/fields|canonical|operation/u);
    const invalid = copying();
    if (invalid.stage !== 'copying') throw new Error('test fixture stage changed');
    expect(() => encodeTransitionRuntimeProgress({
      progress: {
        ...invalid,
        copyCursor: { ...invalid.copyCursor, activeFile: undefined, directories: [], state: 'copying' },
      },
    })).toThrow(/directory frame/u);
  });

  it('rejects active file offsets beyond captured size', () => {
    const progress = copying();
    if (progress.stage !== 'copying' || progress.copyCursor.activeFile === undefined) throw new Error('test fixture changed');
    expect(() => encodeTransitionRuntimeProgress({
      progress: {
        ...progress,
        copyCursor: {
          ...progress.copyCursor,
          activeFile: { ...progress.copyCursor.activeFile, offset: progress.copyCursor.activeFile.size + 1n },
        },
      },
    })).toThrow(/offset|size/u);
  });
});
