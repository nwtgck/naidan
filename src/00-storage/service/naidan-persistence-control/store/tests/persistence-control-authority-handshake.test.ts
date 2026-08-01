import { describe, expect, it } from 'vitest';
import type {
  PersistenceControlReadablePhysicalPort,
} from '@/00-storage/service/naidan-persistence-control/store';
import {
  capturePersistenceControlAuthority,
  createCapturedPersistenceControlReadablePhysicalPort,
  recheckPersistenceControlAuthority,
  type CapturedPersistenceControlAuthority,
} from '@/00-storage/service/naidan-persistence-control/store/persistence-control-authority-handshake';

class MemoryReadablePhysicalPort implements PersistenceControlReadablePhysicalPort {
  readonly copies: [Uint8Array | undefined, Uint8Array | undefined];

  constructor({ first, second }: {
    first: Uint8Array | undefined;
    second: Uint8Array | undefined;
  }) {
    this.copies = [first, second];
  }

  async readFileBounded({ copy, maximumByteLength }: {
    copy: 0 | 1;
    maximumByteLength: number;
  }): Promise<Uint8Array | undefined> {
    const bytes = this.copies[copy];
    if (bytes !== undefined && bytes.byteLength > maximumByteLength) {
      throw new RangeError('test file exceeds maximum');
    }
    return bytes;
  }
}

describe('Persistence Control authority handshake', () => {
  it('detaches captured bytes and supplies bounded verification reads', async () => {
    const first = Uint8Array.of(1, 2, 3);
    const second = Uint8Array.of(4, 5);
    const physical = new MemoryReadablePhysicalPort({ first, second });
    const captured = await capturePersistenceControlAuthority({ physical });
    first.fill(9);
    second.fill(8);

    const detached = createCapturedPersistenceControlReadablePhysicalPort({ captured });
    await expect(detached.readFileBounded({ copy: 0, maximumByteLength: 3 }))
      .resolves.toEqual(Uint8Array.of(1, 2, 3));
    await expect(detached.readFileBounded({ copy: 1, maximumByteLength: 1 }))
      .rejects.toThrow('exceeds the requested bounded read limit');

    const returned = await detached.readFileBounded({ copy: 0, maximumByteLength: 3 });
    returned?.fill(7);
    await expect(detached.readFileBounded({ copy: 0, maximumByteLength: 3 }))
      .resolves.toEqual(Uint8Array.of(1, 2, 3));
  });

  it('accepts unchanged copies and rejects changed or missing authority', async () => {
    const physical = new MemoryReadablePhysicalPort({
      first: Uint8Array.of(1, 2),
      second: Uint8Array.of(3, 4),
    });
    const captured = await capturePersistenceControlAuthority({ physical });
    await expect(recheckPersistenceControlAuthority({ captured, physical })).resolves.toBeUndefined();

    physical.copies[1] = Uint8Array.of(3, 5);
    await expect(recheckPersistenceControlAuthority({ captured, physical }))
      .rejects.toMatchObject({ name: 'PersistenceControlAuthorityChangedError' });

    physical.copies[1] = undefined;
    await expect(recheckPersistenceControlAuthority({ captured, physical }))
      .rejects.toMatchObject({ name: 'PersistenceControlAuthorityChangedError' });
  });

  it('rejects authority capabilities not created by this owner', () => {
    const foreign = Object.freeze({}) as CapturedPersistenceControlAuthority;
    expect(() => createCapturedPersistenceControlReadablePhysicalPort({ captured: foreign }))
      .toThrow('foreign or invalid');
  });
});
