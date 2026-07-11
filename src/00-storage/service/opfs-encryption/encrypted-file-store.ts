import {
  EncryptedFileManifestSchemaDto,
  type EncryptedFileManifestDto,
} from '@/00-storage/00-dto/encryption.dto';
import type { StorageBinaryObjectReadHandle } from '@/00-storage/service/binary-object-io';
import { encodeBase64Url } from './base64-url';
import { EncryptedObjectStore } from './encrypted-object-store';

const DEFAULT_LOGICAL_CHUNK_SIZE = 1024 * 1024;
const UTF8 = new TextEncoder();
const UTF8_DECODER = new TextDecoder('utf-8', { fatal: true });

function createChunkId(): string {
  return encodeBase64Url({ bytes: crypto.getRandomValues(new Uint8Array(16)) });
}

function assertNonNegativeSafeInteger({
  value,
  fieldName,
}: {
  value: number,
  fieldName: string,
}): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${fieldName} must be a non-negative safe integer`);
  }
}

function getChunkCount({
  logicalSize,
  logicalChunkSize,
}: {
  logicalSize: number,
  logicalChunkSize: number,
}): number {
  return logicalSize === 0 ? 0 : Math.ceil(logicalSize / logicalChunkSize);
}

function getChunkLogicalLength({
  logicalSize,
  logicalChunkSize,
  chunkIndex,
}: {
  logicalSize: number,
  logicalChunkSize: number,
  chunkIndex: number,
}): number {
  return Math.max(0, Math.min(
    logicalChunkSize,
    logicalSize - chunkIndex * logicalChunkSize,
  ));
}

function assertFileManifest({
  manifest,
  expectedFileId,
}: {
  manifest: EncryptedFileManifestDto,
  expectedFileId: string,
}): void {
  if (manifest.fileId !== expectedFileId) {
    throw new Error(`Encrypted file manifest ID mismatch: ${expectedFileId}`);
  }
  if (
    !Number.isSafeInteger(manifest.logicalSize)
    || manifest.logicalSize < 0
    || !Number.isSafeInteger(manifest.logicalChunkSize)
    || manifest.logicalChunkSize <= 0
    || !Number.isSafeInteger(manifest.modifiedAt)
    || manifest.modifiedAt < 0
    || manifest.chunkIds.length !== getChunkCount({
      logicalSize: manifest.logicalSize,
      logicalChunkSize: manifest.logicalChunkSize,
    })
  ) {
    throw new Error(`Encrypted file manifest is invalid: ${expectedFileId}`);
  }

  const seenChunkIds = new Set<string>();
  for (const chunkId of manifest.chunkIds) {
    if (chunkId === null) {
      continue;
    }
    if (chunkId.length === 0) {
      throw new Error(`Encrypted file manifest contains an empty chunk ID: ${expectedFileId}`);
    }
    if (seenChunkIds.has(chunkId)) {
      throw new Error(`Encrypted file manifest contains a duplicate chunk ID: ${expectedFileId}`);
    }
    seenChunkIds.add(chunkId);
  }
}

async function writeStreamChunks({
  source,
  logicalChunkSize,
  signal,
  writeChunk,
}: {
  source: ReadableStream<Uint8Array>,
  logicalChunkSize: number,
  signal: AbortSignal | undefined,
  writeChunk: ({ plaintext }: { plaintext: Uint8Array }) => Promise<void>,
}): Promise<number> {
  const reader = source.getReader();
  let pending = new Uint8Array(logicalChunkSize);
  let pendingLength = 0;
  let totalSize = 0;

  try {
    while (true) {
      signal?.throwIfAborted();
      const result = await reader.read();
      if (result.done) {
        break;
      }

      let sourceOffset = 0;
      while (sourceOffset < result.value.byteLength) {
        signal?.throwIfAborted();
        const copied = Math.min(
          logicalChunkSize - pendingLength,
          result.value.byteLength - sourceOffset,
        );
        pending.set(
          result.value.subarray(sourceOffset, sourceOffset + copied),
          pendingLength,
        );
        pendingLength += copied;
        sourceOffset += copied;
        totalSize += copied;

        if (pendingLength !== logicalChunkSize) {
          continue;
        }

        await writeChunk({ plaintext: pending });
        pending = new Uint8Array(logicalChunkSize);
        pendingLength = 0;
      }
    }

    if (pendingLength > 0) {
      await writeChunk({ plaintext: pending.slice(0, pendingLength) });
    }

    return totalSize;
  } catch (error) {
    try {
      await reader.cancel(error);
    } catch {
      // Preserve the original read, write, or abort error.
    }
    throw error;
  } finally {
    reader.releaseLock();
  }
}

export class EncryptedFileStore {
  constructor({ objectStore }: { objectStore: EncryptedObjectStore }) {
    this.objectStore = objectStore;
  }

  private readonly objectStore: EncryptedObjectStore;

  async write({
    fileId,
    source,
    logicalSize,
    modifiedAt,
    signal,
  }: {
    fileId: string,
    source: ReadableStream<Uint8Array>,
    logicalSize: number,
    modifiedAt: number,
    signal: AbortSignal | undefined,
  }): Promise<void> {
    assertNonNegativeSafeInteger({ value: logicalSize, fieldName: 'Logical size' });
    const oldManifest = await this.readManifest({ fileId });
    const chunkIds: string[] = [];

    try {
      const actualSize = await writeStreamChunks({
        source,
        logicalChunkSize: DEFAULT_LOGICAL_CHUNK_SIZE,
        signal,
        writeChunk: async ({ plaintext }) => {
          chunkIds.push(await this.writeNewChunk({ plaintext }));
        },
      });

      if (actualSize !== logicalSize) {
        throw new Error(
          `Encrypted file size mismatch: expected ${logicalSize}, received ${actualSize}`,
        );
      }

      await this.writeManifest({
        manifest: {
          fileId,
          logicalSize,
          logicalChunkSize: DEFAULT_LOGICAL_CHUNK_SIZE,
          modifiedAt,
          chunkIds,
        },
      });
    } catch (error) {
      await this.deleteChunks({ chunkIds });
      throw error;
    }

    if (oldManifest !== undefined) {
      await this.deleteChunks({
        chunkIds: oldManifest.chunkIds.filter((chunkId): chunkId is string => chunkId !== null),
      });
    }
  }

  async createEmpty({
    fileId,
    modifiedAt,
  }: {
    fileId: string,
    modifiedAt: number,
  }): Promise<void> {
    const oldManifest = await this.readManifest({ fileId });
    await this.writeManifest({
      manifest: {
        fileId,
        logicalSize: 0,
        logicalChunkSize: DEFAULT_LOGICAL_CHUNK_SIZE,
        modifiedAt,
        chunkIds: [],
      },
    });
    if (oldManifest !== undefined) {
      await this.deleteChunks({
        chunkIds: oldManifest.chunkIds.filter((chunkId): chunkId is string => chunkId !== null),
      });
    }
  }

  async writeRange({
    fileId,
    bytes,
    position,
    modifiedAt,
    signal,
  }: {
    fileId: string,
    bytes: Uint8Array,
    position: number,
    modifiedAt: number,
    signal: AbortSignal | undefined,
  }): Promise<void> {
    assertNonNegativeSafeInteger({ value: position, fieldName: 'Write position' });
    if (bytes.byteLength === 0) {
      return;
    }

    const oldManifest = await this.readManifest({ fileId }) ?? {
      fileId,
      logicalSize: 0,
      logicalChunkSize: DEFAULT_LOGICAL_CHUNK_SIZE,
      modifiedAt,
      chunkIds: [],
    } satisfies EncryptedFileManifestDto;
    const logicalSize = Math.max(oldManifest.logicalSize, position + bytes.byteLength);
    assertNonNegativeSafeInteger({ value: logicalSize, fieldName: 'Logical size' });
    const chunkIds: Array<string | null> = [...oldManifest.chunkIds];
    chunkIds.length = getChunkCount({
      logicalSize,
      logicalChunkSize: oldManifest.logicalChunkSize,
    });
    for (let index = 0; index < chunkIds.length; index++) {
      if (chunkIds[index] === undefined) {
        chunkIds[index] = null;
      }
    }

    const firstChunkIndex = Math.floor(position / oldManifest.logicalChunkSize);
    const finalPosition = position + bytes.byteLength;
    const lastChunkIndex = Math.floor((finalPosition - 1) / oldManifest.logicalChunkSize);
    const createdChunkIds: string[] = [];
    const replacedChunkIds: string[] = [];

    try {
      for (let chunkIndex = firstChunkIndex; chunkIndex <= lastChunkIndex; chunkIndex++) {
        signal?.throwIfAborted();
        const chunkStart = chunkIndex * oldManifest.logicalChunkSize;
        const chunkLength = getChunkLogicalLength({
          logicalSize,
          logicalChunkSize: oldManifest.logicalChunkSize,
          chunkIndex,
        });
        const plaintext = new Uint8Array(chunkLength);
        const oldChunkId = oldManifest.chunkIds[chunkIndex] ?? null;
        if (oldChunkId !== null) {
          const oldPlaintext = await this.readChunk({ chunkId: oldChunkId });
          const expectedOldLength = getChunkLogicalLength({
            logicalSize: oldManifest.logicalSize,
            logicalChunkSize: oldManifest.logicalChunkSize,
            chunkIndex,
          });
          if (oldPlaintext.byteLength !== expectedOldLength) {
            throw new Error(`Encrypted file chunk size mismatch: ${oldChunkId}`);
          }
          plaintext.set(
            oldPlaintext.subarray(0, Math.min(oldPlaintext.byteLength, plaintext.byteLength)),
          );
        }

        const writeStart = Math.max(position, chunkStart);
        const writeEnd = Math.min(finalPosition, chunkStart + chunkLength);
        const sourceStart = writeStart - position;
        plaintext.set(
          bytes.subarray(sourceStart, sourceStart + writeEnd - writeStart),
          writeStart - chunkStart,
        );

        const newChunkId = await this.writeNewChunk({ plaintext });
        createdChunkIds.push(newChunkId);
        chunkIds[chunkIndex] = newChunkId;
        if (oldChunkId !== null) {
          replacedChunkIds.push(oldChunkId);
        }
      }

      await this.writeManifest({
        manifest: {
          fileId,
          logicalSize,
          logicalChunkSize: oldManifest.logicalChunkSize,
          modifiedAt,
          chunkIds,
        },
      });
    } catch (error) {
      await this.deleteChunks({ chunkIds: createdChunkIds });
      throw error;
    }

    await this.deleteChunks({ chunkIds: replacedChunkIds });
  }

  async truncate({
    fileId,
    logicalSize,
    modifiedAt,
  }: {
    fileId: string,
    logicalSize: number,
    modifiedAt: number,
  }): Promise<void> {
    assertNonNegativeSafeInteger({ value: logicalSize, fieldName: 'Logical size' });
    const oldManifest = await this.readManifest({ fileId });
    if (oldManifest === undefined) {
      await this.writeManifest({
        manifest: {
          fileId,
          logicalSize,
          logicalChunkSize: DEFAULT_LOGICAL_CHUNK_SIZE,
          modifiedAt,
          chunkIds: Array.from({
            length: getChunkCount({
              logicalSize,
              logicalChunkSize: DEFAULT_LOGICAL_CHUNK_SIZE,
            }),
          }, () => null),
        },
      });
      return;
    }

    const nextChunkCount = getChunkCount({
      logicalSize,
      logicalChunkSize: oldManifest.logicalChunkSize,
    });
    const chunkIds: Array<string | null> = oldManifest.chunkIds.slice(0, nextChunkCount);
    while (chunkIds.length < nextChunkCount) {
      chunkIds.push(null);
    }
    const createdChunkIds: string[] = [];
    const removedChunkIds = oldManifest.chunkIds
      .slice(nextChunkCount)
      .filter((chunkId): chunkId is string => chunkId !== null);

    if (
      logicalSize > 0
      && logicalSize < oldManifest.logicalSize
      && logicalSize % oldManifest.logicalChunkSize !== 0
    ) {
      const lastChunkIndex = nextChunkCount - 1;
      const oldChunkId = oldManifest.chunkIds[lastChunkIndex] ?? null;
      if (oldChunkId !== null) {
        const plaintext = await this.readChunk({ chunkId: oldChunkId });
        const expectedOldLength = getChunkLogicalLength({
          logicalSize: oldManifest.logicalSize,
          logicalChunkSize: oldManifest.logicalChunkSize,
          chunkIndex: lastChunkIndex,
        });
        if (plaintext.byteLength !== expectedOldLength) {
          throw new Error(`Encrypted file chunk size mismatch: ${oldChunkId}`);
        }
        const newChunkId = await this.writeNewChunk({
          plaintext: plaintext.slice(0, logicalSize % oldManifest.logicalChunkSize),
        });
        createdChunkIds.push(newChunkId);
        removedChunkIds.push(oldChunkId);
        chunkIds[lastChunkIndex] = newChunkId;
      }
    }

    try {
      await this.writeManifest({
        manifest: {
          fileId,
          logicalSize,
          logicalChunkSize: oldManifest.logicalChunkSize,
          modifiedAt,
          chunkIds,
        },
      });
    } catch (error) {
      await this.deleteChunks({ chunkIds: createdChunkIds });
      throw error;
    }
    await this.deleteChunks({ chunkIds: removedChunkIds });
  }

  async open({
    fileId,
    mimeType,
  }: {
    fileId: string,
    mimeType: string,
  }): Promise<StorageBinaryObjectReadHandle | null> {
    const manifest = await this.readManifest({ fileId });
    if (manifest === undefined) {
      return null;
    }
    const objectStore = this.objectStore;

    const readRange = async ({
      buffer,
      offset,
      length,
      position,
      signal,
    }: {
      buffer: Uint8Array,
      offset: number,
      length: number,
      position: number,
      signal: AbortSignal | undefined,
    }): Promise<{ bytesRead: number }> => {
      assertNonNegativeSafeInteger({ value: offset, fieldName: 'Buffer offset' });
      assertNonNegativeSafeInteger({ value: length, fieldName: 'Read length' });
      assertNonNegativeSafeInteger({ value: position, fieldName: 'Read position' });
      signal?.throwIfAborted();
      if (length === 0 || position >= manifest.logicalSize || offset >= buffer.byteLength) {
        return { bytesRead: 0 };
      }
      const requestedEnd = Math.min(
        position + length,
        manifest.logicalSize,
        position + buffer.byteLength - offset,
      );
      let currentPosition = position;
      let targetOffset = offset;
      buffer.fill(0, offset, offset + requestedEnd - position);

      while (currentPosition < requestedEnd) {
        signal?.throwIfAborted();
        const chunkIndex = Math.floor(
          currentPosition / manifest.logicalChunkSize,
        );
        const chunkStart = chunkIndex * manifest.logicalChunkSize;
        const sourceStart = currentPosition - chunkStart;
        const segmentLength = Math.min(
          requestedEnd - currentPosition,
          manifest.logicalChunkSize - sourceStart,
        );
        const chunkId = manifest.chunkIds[chunkIndex] ?? null;
        if (chunkId !== null) {
          const plaintext = await objectStore.read({
            locator: { namespace: 'file_chunk', key: chunkId },
          });
          if (plaintext === undefined) {
            throw new Error(`Encrypted file chunk is missing: ${chunkId}`);
          }
          const expectedChunkLength = getChunkLogicalLength({
            logicalSize: manifest.logicalSize,
            logicalChunkSize: manifest.logicalChunkSize,
            chunkIndex,
          });
          if (plaintext.byteLength !== expectedChunkLength) {
            throw new Error(`Encrypted file chunk size mismatch: ${chunkId}`);
          }
          const available = Math.max(0, Math.min(
            segmentLength,
            plaintext.byteLength - sourceStart,
          ));
          if (available > 0) {
            buffer.set(
              plaintext.subarray(sourceStart, sourceStart + available),
              targetOffset,
            );
          }
        }
        currentPosition += segmentLength;
        targetOffset += segmentLength;
      }

      return { bytesRead: requestedEnd - position };
    };

    return {
      size: manifest.logicalSize,
      mimeType,
      backing: { type: 'reader_only' },
      read: readRange,
      stream({ start, end, signal }) {
        const finalEnd = Math.min(end ?? manifest.logicalSize, manifest.logicalSize);
        let position = Math.min(start, finalEnd);
        return new ReadableStream<Uint8Array>({
          async pull(controller) {
            if (position >= finalEnd) {
              controller.close();
              return;
            }
            const buffer = new Uint8Array(Math.min(
              manifest.logicalChunkSize,
              finalEnd - position,
            ));
            try {
              const { bytesRead } = await readRange({
                buffer,
                offset: 0,
                length: buffer.byteLength,
                position,
                signal,
              });
              if (bytesRead === 0) {
                controller.close();
                return;
              }
              position += bytesRead;
              controller.enqueue(bytesRead === buffer.byteLength
                ? buffer
                : buffer.subarray(0, bytesRead));
            } catch (error) {
              controller.error(error);
            }
          },
        });
      },
      async close() {},
    };
  }

  async delete({ fileId }: { fileId: string }): Promise<void> {
    const manifest = await this.readManifest({ fileId });
    await this.objectStore.delete({
      locator: { namespace: 'file_manifest', key: fileId },
    });
    if (manifest !== undefined) {
      await this.deleteChunks({
        chunkIds: manifest.chunkIds.filter((chunkId): chunkId is string => chunkId !== null),
      });
    }
  }

  async readManifest({
    fileId,
  }: {
    fileId: string,
  }): Promise<EncryptedFileManifestDto | undefined> {
    const bytes = await this.objectStore.read({
      locator: { namespace: 'file_manifest', key: fileId },
    });
    if (bytes === undefined) {
      return undefined;
    }
    const manifest = EncryptedFileManifestSchemaDto.parse(
      JSON.parse(UTF8_DECODER.decode(bytes)),
    );
    assertFileManifest({ manifest, expectedFileId: fileId });
    return manifest;
  }

  private async writeManifest({
    manifest,
  }: {
    manifest: EncryptedFileManifestDto,
  }): Promise<void> {
    assertFileManifest({ manifest, expectedFileId: manifest.fileId });
    await this.objectStore.write({
      locator: { namespace: 'file_manifest', key: manifest.fileId },
      plaintext: UTF8.encode(JSON.stringify(manifest)),
    });
  }

  private async writeNewChunk({
    plaintext,
  }: {
    plaintext: Uint8Array,
  }): Promise<string> {
    const chunkId = createChunkId();
    await this.objectStore.write({
      locator: { namespace: 'file_chunk', key: chunkId },
      plaintext,
    });
    return chunkId;
  }

  private async readChunk({ chunkId }: { chunkId: string }): Promise<Uint8Array> {
    const plaintext = await this.objectStore.read({
      locator: { namespace: 'file_chunk', key: chunkId },
    });
    if (plaintext === undefined) {
      throw new Error(`Encrypted file chunk is missing: ${chunkId}`);
    }
    return plaintext;
  }

  private async deleteChunks({ chunkIds }: { chunkIds: string[] }): Promise<void> {
    for (const chunkId of new Set(chunkIds)) {
      await this.objectStore.delete({
        locator: { namespace: 'file_chunk', key: chunkId },
      });
    }
  }
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
  DEFAULT_LOGICAL_CHUNK_SIZE,
  assertFileManifest,
  getChunkCount,
  writeStreamChunks,
};
