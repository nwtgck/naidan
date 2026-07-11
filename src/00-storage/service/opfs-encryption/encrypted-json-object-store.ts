import type { ZodType } from 'zod';
import { EncryptedObjectStore, type EncryptedObjectLocator } from './encrypted-object-store';

const UTF8 = new TextEncoder();
const UTF8_DECODER = new TextDecoder('utf-8', { fatal: true });

export class EncryptedJsonObjectStore {
  constructor({ objectStore }: { objectStore: EncryptedObjectStore }) {
    this.objectStore = objectStore;
  }

  private readonly objectStore: EncryptedObjectStore;

  async read<T>({
    locator,
    schema,
  }: {
    locator: EncryptedObjectLocator,
    schema: ZodType<T>,
  }): Promise<T | undefined> {
    const bytes = await this.objectStore.read({ locator });
    if (bytes === undefined) {
      return undefined;
    }
    return schema.parse(JSON.parse(UTF8_DECODER.decode(bytes)));
  }

  async write({
    locator,
    value,
  }: {
    locator: EncryptedObjectLocator,
    value: unknown,
  }): Promise<void> {
    await this.objectStore.write({
      locator,
      plaintext: UTF8.encode(JSON.stringify(value)),
    });
  }

  async delete({ locator }: { locator: EncryptedObjectLocator }): Promise<void> {
    await this.objectStore.delete({ locator });
  }
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
