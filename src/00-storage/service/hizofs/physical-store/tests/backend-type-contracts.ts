import type {
  HizoFSPhysicalWriteBackend,
  HizoFSWritableFile,
} from '@/00-storage/service/hizofs/physical-store/backend';

declare const authenticatedPhysicalBytesBrand: unique symbol;
type AuthenticatedPhysicalBytes = Uint8Array & {
  readonly [authenticatedPhysicalBytesBrand]: true;
};

declare const authenticatedBytes: AuthenticatedPhysicalBytes;
declare const backend: HizoFSPhysicalWriteBackend<AuthenticatedPhysicalBytes>;
declare const file: HizoFSWritableFile;

void backend.writeAt({ bytes: authenticatedBytes, file, offset: 0n });

// @ts-expect-error Raw bytes have not crossed the authenticated-store boundary.
void backend.writeAt({ bytes: new Uint8Array(), file, offset: 0n });

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
