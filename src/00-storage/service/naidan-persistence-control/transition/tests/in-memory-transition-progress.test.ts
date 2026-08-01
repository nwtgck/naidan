import { describe, expect, it } from 'vitest';
import { parsePortableFileSystemId } from '@/00-storage/service/hizofs/compatibility';
import { parseTransitionOperationId } from '@/00-storage/service/naidan-persistence-control/00-format';
import { createTransitionNamespaceCopyCursor } from '@/00-storage/service/naidan-persistence-control/transition/namespace-copy';
import { InMemoryTransitionProgressPort } from '@/00-storage/service/naidan-persistence-control/transition/in-memory-transition-progress';

const OPERATION = parseTransitionOperationId({ value: 'transition_0123456789' });
const OTHER = parseTransitionOperationId({ value: 'different__0123456789' });
const source = { type: 'plain' } as const;
const target = { fileSystemId: parsePortableFileSystemId({ value: '0123456789_ABCDEFGHIJ' }), type: 'hizofs' } as const;

describe('in-memory transition progress', () => {
  it('returns detached cursor snapshots and clears only the owning operation', async () => {
    const port = new InMemoryTransitionProgressPort();
    await port.save({ progress: { copyCursor: createTransitionNamespaceCopyCursor(), operationId: OPERATION, source, sourceAuthorityIdentity: 'source-v1', stage: 'copying', target } });
    const loaded = await port.load({ operationId: OPERATION });
    expect(loaded).toEqual(await port.load({ operationId: OPERATION }));
    expect(loaded).not.toBe(await port.load({ operationId: OPERATION }));
    await port.clear({ operationId: OTHER });
    expect(await port.load({ operationId: OPERATION })).toBeDefined();
    await port.clear({ operationId: OPERATION });
    expect(await port.load({ operationId: OPERATION })).toBeUndefined();
  });

  it('rejects a second active operation instead of evicting its cursor', async () => {
    const port = new InMemoryTransitionProgressPort();
    await port.save({ progress: { copyCursor: createTransitionNamespaceCopyCursor(), operationId: OPERATION, source, sourceAuthorityIdentity: 'source-v1', stage: 'copying', target } });
    await expect(port.save({ progress: { copyCursor: createTransitionNamespaceCopyCursor(), operationId: OTHER, source, sourceAuthorityIdentity: 'source-v1', stage: 'copying', target } }))
      .rejects.toThrow('another transition operation');
  });
});
