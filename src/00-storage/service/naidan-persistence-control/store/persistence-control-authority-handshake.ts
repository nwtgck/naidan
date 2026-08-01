import {
  NAIDAN_PERSISTENCE_CONTROL_FORMAT_CONSTANTS,
  type PersistenceControlCopy,
} from '@/00-storage/service/naidan-persistence-control/00-format';
import type {
  PersistenceControlReadablePhysicalPort,
} from '@/00-storage/service/naidan-persistence-control/store/persistence-control-store';

declare const capturedPersistenceControlAuthorityBrand: unique symbol;

export type CapturedPersistenceControlAuthority = Readonly<{
  [capturedPersistenceControlAuthorityBrand]: true;
}>;

type CapturedCopies = readonly [Uint8Array | undefined, Uint8Array | undefined];

const capturedCopiesByAuthority = new WeakMap<object, CapturedCopies>();

export class PersistenceControlAuthorityChangedError extends Error {
  constructor() {
    super('Persistence Control authority changed after capture');
    this.name = 'PersistenceControlAuthorityChangedError';
  }
}

function copyBytes({ bytes }: { bytes: Uint8Array | undefined }): Uint8Array | undefined {
  return bytes === undefined ? undefined : new Uint8Array(bytes);
}

function bytesEqual({ left, right }: {
  left: Uint8Array | undefined;
  right: Uint8Array | undefined;
}): boolean {
  if (left === undefined || right === undefined) return left === right;
  return left.byteLength === right.byteLength
    && left.every((byte, index) => byte === right[index]);
}

async function readCopies({ physical }: {
  physical: PersistenceControlReadablePhysicalPort;
}): Promise<CapturedCopies> {
  const maximumByteLength = NAIDAN_PERSISTENCE_CONTROL_FORMAT_CONSTANTS.limits.persistenceControlJsonBytes;
  const first = await physical.readFileBounded({ copy: 0, maximumByteLength });
  const second = await physical.readFileBounded({ copy: 1, maximumByteLength });
  return [copyBytes({ bytes: first }), copyBytes({ bytes: second })];
}

function requireCapturedCopies({ captured }: {
  captured: CapturedPersistenceControlAuthority;
}): CapturedCopies {
  const copies = capturedCopiesByAuthority.get(captured);
  if (copies === undefined) {
    throw new TypeError('Persistence Control authority capture is foreign or invalid');
  }
  return copies;
}

/**
 * Captures only the bounded A/B authority bytes while the provider gate is
 * held. Authentication, passphrase KDF work, and endpoint traversal consume a
 * detached read port outside the gate; the caller then performs one short
 * exact-byte recheck before registering the resulting session.
 */
export async function capturePersistenceControlAuthority({ physical }: {
  physical: PersistenceControlReadablePhysicalPort;
}): Promise<CapturedPersistenceControlAuthority> {
  const captured = Object.freeze({}) as CapturedPersistenceControlAuthority;
  capturedCopiesByAuthority.set(captured, await readCopies({ physical }));
  return captured;
}

export function createCapturedPersistenceControlReadablePhysicalPort({ captured }: {
  captured: CapturedPersistenceControlAuthority;
}): PersistenceControlReadablePhysicalPort {
  const copies = requireCapturedCopies({ captured });
  return {
    async readFileBounded({ copy, maximumByteLength }) {
      const bytes = copies[copy];
      if (bytes === undefined) return undefined;
      if (bytes.byteLength > maximumByteLength) {
        throw new RangeError('captured Persistence Control file exceeds the requested bounded read limit');
      }
      return new Uint8Array(bytes);
    },
  };
}

export async function recheckPersistenceControlAuthority({ captured, physical }: {
  captured: CapturedPersistenceControlAuthority;
  physical: PersistenceControlReadablePhysicalPort;
}): Promise<void> {
  const expected = requireCapturedCopies({ captured });
  const current = await readCopies({ physical });
  for (const copy of [0, 1] as const satisfies readonly PersistenceControlCopy[]) {
    if (!bytesEqual({ left: expected[copy], right: current[copy] })) {
      throw new PersistenceControlAuthorityChangedError();
    }
  }
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
