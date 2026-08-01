import { describe, expect, it } from 'vitest';
import { parsePortableFileSystemId } from '@/00-storage/service/hizofs/compatibility';
import { parseTransitionOperationId } from '@/00-storage/service/naidan-persistence-control/00-format';
import {
  authoritativeTransitionEndpoint,
  createBuildingTransitionMode,
  planStableTransitionCompletion,
  planStableTransitionSourceRecovery,
  planTransitionAuthoritySwitch,
} from '@/00-storage/service/naidan-persistence-control/transition/transition-state-machine';

const SOURCE = parsePortableFileSystemId({ value: '0123456789_ABCDEFGHIJ' });
const TARGET = parsePortableFileSystemId({ value: 'ABCDEFGHIJ_0123456789' });
const OPERATION = parseTransitionOperationId({ value: 'transition_0123456789' });
const source = { fileSystemId: SOURCE, type: 'hizofs' } as const;
const target = { fileSystemId: TARGET, type: 'hizofs' } as const;

function verified() {
  return {
    contentVerified: true,
    metadataVerified: true,
    operationId: OPERATION,
    source,
    target,
    targetDurable: true,
    targetNormalOpenVerified: true,
    targetWriterClosed: true,
  } as const;
}

describe('Naidan Persistence Control transition state machine', () => {
  it('keeps the source authoritative while building the target', () => {
    const mode = createBuildingTransitionMode({ operationId: OPERATION, source, target });
    expect(mode.operation).toBe('re_encrypt');
    expect(authoritativeTransitionEndpoint({ mode })).toEqual(source);
  });

  it('switches authority only with a proof bound to the active operation and endpoints', () => {
    const building = createBuildingTransitionMode({ operationId: OPERATION, source, target });
    const cleaning = planTransitionAuthoritySwitch({ mode: building, verification: verified() });
    expect(authoritativeTransitionEndpoint({ mode: cleaning })).toEqual(target);
    expect(cleaning.phase.type).toBe('cleaning_up_source');
  });

  it('rejects verification from another operation', () => {
    const building = createBuildingTransitionMode({ operationId: OPERATION, source, target });
    expect(() => planTransitionAuthoritySwitch({
      mode: building,
      verification: { ...verified(), operationId: parseTransitionOperationId({ value: 'different__0123456789' }) },
    })).toThrow('does not belong');
  });

  it('rejects a runtime verification object with an incomplete proof', () => {
    const building = createBuildingTransitionMode({ operationId: OPERATION, source, target });
    expect(() => planTransitionAuthoritySwitch({
      mode: building,
      verification: { ...verified(), contentVerified: false } as unknown as ReturnType<typeof verified>,
    })).toThrow('not fully verified');
  });

  it('does not switch the same operation twice', () => {
    const building = createBuildingTransitionMode({ operationId: OPERATION, source, target });
    const cleaning = planTransitionAuthoritySwitch({ mode: building, verification: verified() });
    expect(() => planTransitionAuthoritySwitch({ mode: cleaning, verification: verified() })).toThrow('already switched');
  });

  it('records the old HizoFS source as retired after re-encrypt switch', () => {
    const building = createBuildingTransitionMode({ operationId: OPERATION, source, target });
    const cleaning = planTransitionAuthoritySwitch({ mode: building, verification: verified() });
    expect(planStableTransitionCompletion({ mode: cleaning, retiredFileSystemIds: [] })).toEqual({
      mode: { activeFileSystemId: TARGET, type: 'hizofs' },
      retiredFileSystemIds: [SOURCE],
    });
  });

  it('records the protected source as retired when decrypt becomes stable plain', () => {
    const plain = { type: 'plain' } as const;
    const building = createBuildingTransitionMode({ operationId: OPERATION, source, target: plain });
    const cleaning = planTransitionAuthoritySwitch({
      mode: building,
      verification: { ...verified(), target: plain },
    });
    expect(planStableTransitionCompletion({ mode: cleaning, retiredFileSystemIds: [] })).toEqual({
      mode: { type: 'plain' },
      retiredFileSystemIds: [SOURCE],
    });
  });

  it('does not retire a plain source after encrypt', () => {
    const plain = { type: 'plain' } as const;
    const building = createBuildingTransitionMode({ operationId: OPERATION, source: plain, target });
    const cleaning = planTransitionAuthoritySwitch({
      mode: building,
      verification: { ...verified(), source: plain },
    });
    expect(planStableTransitionCompletion({ mode: cleaning, retiredFileSystemIds: [] })).toEqual({
      mode: { activeFileSystemId: TARGET, type: 'hizofs' },
      retiredFileSystemIds: [],
    });
  });

  it('rejects a corrupt retired set instead of silently normalizing it', () => {
    const building = createBuildingTransitionMode({ operationId: OPERATION, source, target });
    const cleaning = planTransitionAuthoritySwitch({ mode: building, verification: verified() });
    expect(() => planStableTransitionCompletion({ mode: cleaning, retiredFileSystemIds: [TARGET] })).toThrow('cannot already be retired');
    expect(() => planStableTransitionCompletion({ mode: cleaning, retiredFileSystemIds: [SOURCE, SOURCE] })).toThrow('unique and canonically ordered');
  });

  it('rejects stable completion before the authority switch', () => {
    const building = createBuildingTransitionMode({ operationId: OPERATION, source, target });
    expect(() => planStableTransitionCompletion({ mode: building, retiredFileSystemIds: [] })).toThrow('source remains authoritative');
  });

  it('recovers the stable source before authority switch and retires an incomplete HizoFS target', () => {
    const building = createBuildingTransitionMode({ operationId: OPERATION, source, target });

    expect(planStableTransitionSourceRecovery({ mode: building, retiredFileSystemIds: [] })).toEqual({
      mode: { activeFileSystemId: SOURCE, type: 'hizofs' },
      retiredFileSystemIds: [TARGET],
    });
  });

  it('recovers stable plain before an interrupted enable switch', () => {
    const building = createBuildingTransitionMode({
      operationId: OPERATION,
      source: { type: 'plain' },
      target,
    });

    expect(planStableTransitionSourceRecovery({ mode: building, retiredFileSystemIds: [] })).toEqual({
      mode: { type: 'plain' },
      retiredFileSystemIds: [TARGET],
    });
  });

  it('rejects source recovery after authority already switched', () => {
    const building = createBuildingTransitionMode({ operationId: OPERATION, source, target });
    const cleaning = planTransitionAuthoritySwitch({ mode: building, verification: verified() });

    expect(() => planStableTransitionSourceRecovery({
      mode: cleaning,
      retiredFileSystemIds: [],
    })).toThrow('target remains authoritative');
  });

});
