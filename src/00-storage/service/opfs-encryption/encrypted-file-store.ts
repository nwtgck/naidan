import {
  EncryptedFileChunkMapPageSchemaDto,
  EncryptedFileManifestSchemaDto,
  type EncryptedFileChunkMapPageDto,
  type EncryptedFileManifestDto,
} from '@/00-storage/00-dto/encryption.dto';
import type { StorageBinaryObjectReadHandle } from '@/00-storage/service/binary-object-io';
import { encodeBase64Url } from './base64-url';
import { EncryptedObjectStore } from './encrypted-object-store';
import { EncryptedObjectTransactionCoordinator } from './encrypted-object-transaction-coordinator';
import {
  acquireEncryptedStorageLock,
  tryAcquireEncryptedStorageLock,
} from './encrypted-storage-lock';

const DEFAULT_CHUNK_SIZE = 1024 * 1024;
const DEFAULT_CHUNK_MAP_PAGE_SIZE = 1024;
const UTF8 = new TextEncoder();
const UTF8_DECODER = new TextDecoder('utf-8', { fatal: true });

function createOpaqueId(): string {
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
  size,
  chunkSize,
}: {
  size: number,
  chunkSize: number,
}): number {
  return size === 0 ? 0 : Math.ceil(size / chunkSize);
}

function getChunkLength({
  size,
  chunkSize,
  chunkIndex,
}: {
  size: number,
  chunkSize: number,
  chunkIndex: number,
}): number {
  return Math.max(0, Math.min(
    chunkSize,
    size - chunkIndex * chunkSize,
  ));
}

function getChunkMapPageCount({
  chunkCount,
  chunkMapPageSize,
}: {
  chunkCount: number,
  chunkMapPageSize: number,
}): number {
  return chunkCount === 0 ? 0 : Math.ceil(chunkCount / chunkMapPageSize);
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
    !Number.isSafeInteger(manifest.revision)
    || manifest.revision < 0
    || !Number.isSafeInteger(manifest.size)
    || manifest.size < 0
    || !Number.isSafeInteger(manifest.chunkSize)
    || manifest.chunkSize <= 0
    || !Number.isSafeInteger(manifest.chunkMapPageSize)
    || manifest.chunkMapPageSize <= 0
    || (
      manifest.createdAt !== null
      && (!Number.isSafeInteger(manifest.createdAt) || manifest.createdAt < 0)
    )
    || !Number.isSafeInteger(manifest.modifiedAt)
    || manifest.modifiedAt < 0
    || manifest.chunkMapPageIds.length !== getChunkMapPageCount({
      chunkCount: getChunkCount({ size: manifest.size, chunkSize: manifest.chunkSize }),
      chunkMapPageSize: manifest.chunkMapPageSize,
    })
  ) {
    throw new Error(`Encrypted file manifest is invalid: ${expectedFileId}`);
  }
  const seenPageIds = new Set<string>();
  for (const pageId of manifest.chunkMapPageIds) {
    if (pageId.length === 0 || seenPageIds.has(pageId)) {
      throw new Error(`Encrypted file manifest contains an invalid chunk-map page: ${expectedFileId}`);
    }
    seenPageIds.add(pageId);
  }
}

function assertChunkMapPage({
  page,
  manifest,
  pageIndex,
}: {
  page: EncryptedFileChunkMapPageDto,
  manifest: EncryptedFileManifestDto,
  pageIndex: number,
}): void {
  const expectedPageId = manifest.chunkMapPageIds[pageIndex];
  if (
    expectedPageId === undefined
    || page.pageId !== expectedPageId
    || page.fileId !== manifest.fileId
    || page.pageIndex !== pageIndex
  ) {
    throw new Error(`Encrypted file chunk-map page identity mismatch: ${manifest.fileId}/${pageIndex}`);
  }
  const chunkCount = getChunkCount({ size: manifest.size, chunkSize: manifest.chunkSize });
  const expectedLength = Math.min(
    manifest.chunkMapPageSize,
    chunkCount - pageIndex * manifest.chunkMapPageSize,
  );
  if (page.chunkIds.length !== expectedLength) {
    throw new Error(`Encrypted file chunk-map page length mismatch: ${manifest.fileId}/${pageIndex}`);
  }
  const seenChunkIds = new Set<string>();
  for (const chunkId of page.chunkIds) {
    if (chunkId === null) {
      continue;
    }
    if (chunkId.length === 0 || seenChunkIds.has(chunkId)) {
      throw new Error(`Encrypted file chunk-map page contains an invalid chunk ID: ${page.pageId}`);
    }
    seenChunkIds.add(chunkId);
  }
}

async function writeStreamChunks({
  source,
  chunkSize,
  signal,
  writeChunk,
}: {
  source: ReadableStream<Uint8Array>,
  chunkSize: number,
  signal: AbortSignal | undefined,
  writeChunk: ({ plaintext }: { plaintext: Uint8Array }) => Promise<void>,
}): Promise<number> {
  const reader = source.getReader();
  let pending = new Uint8Array(chunkSize);
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
          chunkSize - pendingLength,
          result.value.byteLength - sourceOffset,
        );
        pending.set(result.value.subarray(sourceOffset, sourceOffset + copied), pendingLength);
        pendingLength += copied;
        sourceOffset += copied;
        totalSize += copied;
        if (pendingLength === chunkSize) {
          await writeChunk({ plaintext: pending });
          pending = new Uint8Array(chunkSize);
          pendingLength = 0;
        }
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
  private readonly coordinators = new Map<string, Promise<EncryptedObjectTransactionCoordinator>>();
  private readonly pendingCleanupManifests = new Map<
    string,
    Map<number, EncryptedFileManifestDto>
  >();
  private readonly cleanupAttempts = new Map<string, Promise<void>>();
  private readonly cleanupRetryRequests = new Set<string>();

  async write({
    fileId,
    source,
    size,
    createdAt,
    modifiedAt,
    signal,
  }: {
    fileId: string,
    source: ReadableStream<Uint8Array>,
    size: number,
    createdAt?: number | null,
    modifiedAt: number,
    signal: AbortSignal | undefined,
  }): Promise<void> {
    assertNonNegativeSafeInteger({ value: size, fieldName: 'File size' });
    const coordinator = await this.getCoordinator({ fileId });
    await coordinator.mutate({
      prepare: async () => {
        const oldManifest = await this.readManifestUnsafe({ fileId });
        const chunkIds: string[] = [];
        const createdPageIds: string[] = [];
        try {
          const actualSize = await writeStreamChunks({
            source,
            chunkSize: DEFAULT_CHUNK_SIZE,
            signal,
            writeChunk: async ({ plaintext }) => {
              chunkIds.push(await this.writeNewChunk({ plaintext }));
            },
          });
          if (actualSize !== size) {
            throw new Error(`Encrypted file size mismatch: expected ${size}, received ${actualSize}`);
          }
          const chunkMapPageIds = await this.writeChunkMapPages({
            fileId,
            chunkIds,
            onPageCreated: ({ pageId }) => createdPageIds.push(pageId),
          });
          const manifest: EncryptedFileManifestDto = {
            fileId,
            revision: (oldManifest?.revision ?? -1) + 1,
            size,
            chunkSize: DEFAULT_CHUNK_SIZE,
            chunkMapPageSize: DEFAULT_CHUNK_MAP_PAGE_SIZE,
            chunkMapPageIds,
            createdAt: oldManifest === undefined
              ? (createdAt === undefined ? modifiedAt : createdAt)
              : oldManifest.createdAt,
            modifiedAt,
          };
          assertFileManifest({ manifest, expectedFileId: fileId });
          return {
            operations: [{
              type: 'write' as const,
              locator: this.getManifestLocator({ fileId }),
              plaintext: UTF8.encode(JSON.stringify(manifest)),
            }],
            cleanupAfterFailure: async () => {
              await this.deleteChunks({ chunkIds });
              await this.deleteChunkMapPages({ pageIds: createdPageIds });
            },
            cleanupAfterCommit: oldManifest === undefined
              ? undefined
              : async () => this.scheduleReplacedManifestCleanup({ manifest: oldManifest }),
          };
        } catch (error) {
          await this.deleteChunks({ chunkIds });
          await this.deleteChunkMapPages({ pageIds: createdPageIds });
          throw error;
        }
      },
      result: async () => undefined,
    });
  }

  async createEmpty({
    fileId,
    createdAt,
    modifiedAt,
  }: {
    fileId: string,
    createdAt?: number | null,
    modifiedAt: number,
  }): Promise<void> {
    const coordinator = await this.getCoordinator({ fileId });
    await coordinator.mutate({
      prepare: async () => {
        const oldManifest = await this.readManifestUnsafe({ fileId });
        const manifest: EncryptedFileManifestDto = {
          fileId,
          revision: (oldManifest?.revision ?? -1) + 1,
          size: 0,
          chunkSize: DEFAULT_CHUNK_SIZE,
          chunkMapPageSize: DEFAULT_CHUNK_MAP_PAGE_SIZE,
          chunkMapPageIds: [],
          createdAt: oldManifest === undefined
            ? (createdAt === undefined ? modifiedAt : createdAt)
            : oldManifest.createdAt,
          modifiedAt,
        };
        assertFileManifest({ manifest, expectedFileId: fileId });
        return {
          operations: [{
            type: 'write' as const,
            locator: this.getManifestLocator({ fileId }),
            plaintext: UTF8.encode(JSON.stringify(manifest)),
          }],
          cleanupAfterCommit: oldManifest === undefined
            ? undefined
            : async () => this.scheduleReplacedManifestCleanup({ manifest: oldManifest }),
        };
      },
      result: async () => undefined,
    });
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
    const coordinator = await this.getCoordinator({ fileId });
    await coordinator.mutate({
      prepare: async () => {
        const persistedManifest = await this.readManifestUnsafe({ fileId });
        const oldManifest = persistedManifest ?? {
          fileId,
          revision: -1,
          size: 0,
          chunkSize: DEFAULT_CHUNK_SIZE,
          chunkMapPageSize: DEFAULT_CHUNK_MAP_PAGE_SIZE,
          chunkMapPageIds: [],
          createdAt: modifiedAt,
          modifiedAt,
        } satisfies EncryptedFileManifestDto;
        const oldChunkIds = await this.readAllChunkIds({ manifest: oldManifest });
        const size = Math.max(oldManifest.size, position + bytes.byteLength);
        assertNonNegativeSafeInteger({ value: size, fieldName: 'File size' });
        const chunkIds: Array<string | null> = oldChunkIds.slice();
        chunkIds.length = getChunkCount({ size, chunkSize: oldManifest.chunkSize });
        for (let index = 0; index < chunkIds.length; index++) {
          if (chunkIds[index] === undefined) {
            chunkIds[index] = null;
          }
        }
        const firstChunkIndex = Math.floor(position / oldManifest.chunkSize);
        const finalPosition = position + bytes.byteLength;
        const lastChunkIndex = Math.floor((finalPosition - 1) / oldManifest.chunkSize);
        const createdChunkIds: string[] = [];
        const createdPageIds: string[] = [];
        try {
          for (let chunkIndex = firstChunkIndex; chunkIndex <= lastChunkIndex; chunkIndex++) {
            signal?.throwIfAborted();
            const chunkStart = chunkIndex * oldManifest.chunkSize;
            const chunkLength = getChunkLength({ size, chunkSize: oldManifest.chunkSize, chunkIndex });
            const plaintext = new Uint8Array(chunkLength);
            const oldChunkId = oldChunkIds[chunkIndex] ?? null;
            if (oldChunkId !== null) {
              const oldPlaintext = await this.readChunk({ chunkId: oldChunkId });
              const expectedOldLength = getChunkLength({
                size: oldManifest.size,
                chunkSize: oldManifest.chunkSize,
                chunkIndex,
              });
              if (oldPlaintext.byteLength !== expectedOldLength) {
                throw new Error(`Encrypted file chunk size mismatch: ${oldChunkId}`);
              }
              plaintext.set(oldPlaintext.subarray(0, Math.min(oldPlaintext.byteLength, plaintext.byteLength)));
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
          }
          const chunkMapPageIds = await this.writeChunkMapPages({
            fileId,
            chunkIds,
            onPageCreated: ({ pageId }) => createdPageIds.push(pageId),
          });
          const manifest: EncryptedFileManifestDto = {
            fileId,
            revision: oldManifest.revision + 1,
            size,
            chunkSize: oldManifest.chunkSize,
            chunkMapPageSize: oldManifest.chunkMapPageSize,
            chunkMapPageIds,
            createdAt: oldManifest.createdAt,
            modifiedAt,
          };
          assertFileManifest({ manifest, expectedFileId: fileId });
          return {
            operations: [{
              type: 'write' as const,
              locator: this.getManifestLocator({ fileId }),
              plaintext: UTF8.encode(JSON.stringify(manifest)),
            }],
            cleanupAfterFailure: async () => {
              await this.deleteChunks({ chunkIds: createdChunkIds });
              await this.deleteChunkMapPages({ pageIds: createdPageIds });
            },
            cleanupAfterCommit: persistedManifest === undefined
              ? undefined
              : async () => this.scheduleReplacedManifestCleanup({ manifest: oldManifest }),
          };
        } catch (error) {
          await this.deleteChunks({ chunkIds: createdChunkIds });
          await this.deleteChunkMapPages({ pageIds: createdPageIds });
          throw error;
        }
      },
      result: async () => undefined,
    });
  }

  async truncate({
    fileId,
    size,
    modifiedAt,
  }: {
    fileId: string,
    size: number,
    modifiedAt: number,
  }): Promise<void> {
    assertNonNegativeSafeInteger({ value: size, fieldName: 'File size' });
    const coordinator = await this.getCoordinator({ fileId });
    await coordinator.mutate({
      prepare: async () => {
        const oldManifest = await this.readManifestUnsafe({ fileId });
        if (oldManifest === undefined) {
          const chunkIds = Array.from({
            length: getChunkCount({ size, chunkSize: DEFAULT_CHUNK_SIZE }),
          }, () => null);
          const createdPageIds: string[] = [];
          try {
            const pageIds = await this.writeChunkMapPages({
              fileId,
              chunkIds,
              onPageCreated: ({ pageId }) => createdPageIds.push(pageId),
            });
            const manifest: EncryptedFileManifestDto = {
              fileId,
              revision: 0,
              size,
              chunkSize: DEFAULT_CHUNK_SIZE,
              chunkMapPageSize: DEFAULT_CHUNK_MAP_PAGE_SIZE,
              chunkMapPageIds: pageIds,
              createdAt: modifiedAt,
              modifiedAt,
            };
            assertFileManifest({ manifest, expectedFileId: fileId });
            return {
              operations: [{
                type: 'write' as const,
                locator: this.getManifestLocator({ fileId }),
                plaintext: UTF8.encode(JSON.stringify(manifest)),
              }],
              cleanupAfterFailure: async () => {
                await this.deleteChunkMapPages({ pageIds: createdPageIds });
              },
            };
          } catch (error) {
            await this.deleteChunkMapPages({ pageIds: createdPageIds });
            throw error;
          }
        }
        const oldChunkIds = await this.readAllChunkIds({ manifest: oldManifest });
        const nextChunkCount = getChunkCount({ size, chunkSize: oldManifest.chunkSize });
        const chunkIds: Array<string | null> = oldChunkIds.slice(0, nextChunkCount);
        while (chunkIds.length < nextChunkCount) {
          chunkIds.push(null);
        }
        const createdChunkIds: string[] = [];
        const createdPageIds: string[] = [];
        try {
          if (size > 0 && size < oldManifest.size && size % oldManifest.chunkSize !== 0) {
            const lastChunkIndex = nextChunkCount - 1;
            const oldChunkId = oldChunkIds[lastChunkIndex] ?? null;
            if (oldChunkId !== null) {
              const plaintext = await this.readChunk({ chunkId: oldChunkId });
              const expectedOldLength = getChunkLength({
                size: oldManifest.size,
                chunkSize: oldManifest.chunkSize,
                chunkIndex: lastChunkIndex,
              });
              if (plaintext.byteLength !== expectedOldLength) {
                throw new Error(`Encrypted file chunk size mismatch: ${oldChunkId}`);
              }
              const newChunkId = await this.writeNewChunk({
                plaintext: plaintext.slice(0, size % oldManifest.chunkSize),
              });
              createdChunkIds.push(newChunkId);
              chunkIds[lastChunkIndex] = newChunkId;
            }
          }
          const pageIds = await this.writeChunkMapPages({
            fileId,
            chunkIds,
            onPageCreated: ({ pageId }) => createdPageIds.push(pageId),
          });
          const manifest: EncryptedFileManifestDto = {
            fileId,
            revision: oldManifest.revision + 1,
            size,
            chunkSize: oldManifest.chunkSize,
            chunkMapPageSize: oldManifest.chunkMapPageSize,
            chunkMapPageIds: pageIds,
            createdAt: oldManifest.createdAt,
            modifiedAt,
          };
          assertFileManifest({ manifest, expectedFileId: fileId });
          return {
            operations: [{
              type: 'write' as const,
              locator: this.getManifestLocator({ fileId }),
              plaintext: UTF8.encode(JSON.stringify(manifest)),
            }],
            cleanupAfterFailure: async () => {
              await this.deleteChunks({ chunkIds: createdChunkIds });
              await this.deleteChunkMapPages({ pageIds: createdPageIds });
            },
            cleanupAfterCommit: async () => this.scheduleReplacedManifestCleanup({ manifest: oldManifest }),
          };
        } catch (error) {
          await this.deleteChunks({ chunkIds: createdChunkIds });
          await this.deleteChunkMapPages({ pageIds: createdPageIds });
          throw error;
        }
      },
      result: async () => undefined,
    });
  }

  async open({
    fileId,
    mimeType,
  }: {
    fileId: string,
    mimeType: string,
  }): Promise<StorageBinaryObjectReadHandle | null> {
    const coordinator = await this.getCoordinator({ fileId });
    return await coordinator.read({
      run: async () => {
        const manifest = await this.readManifestUnsafe({ fileId });
        if (manifest === undefined) {
          return null;
        }
        const historyLease = await acquireEncryptedStorageLock({
          lockName: await this.getFileHistoryLockName({ fileId: manifest.fileId }),
          mode: 'shared',
        });
        let closed = false;
        const assertOpen = (): void => {
          if (closed) {
            throw new Error(`Encrypted file handle is closed: ${fileId}`);
          }
        };
        const requestPendingCleanup = (): void => {
          this.requestPendingCleanup({ fileId: manifest.fileId });
        };
        const pageCache = new Map<number, EncryptedFileChunkMapPageDto>();
        const getChunkId = async ({ chunkIndex }: { chunkIndex: number }): Promise<string | null> => {
          const pageIndex = Math.floor(chunkIndex / manifest.chunkMapPageSize);
          let page = pageCache.get(pageIndex);
          if (page === undefined) {
            page = await this.readChunkMapPage({ manifest, pageIndex });
            pageCache.set(pageIndex, page);
          }
          return page.chunkIds[chunkIndex % manifest.chunkMapPageSize] ?? null;
        };
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
          assertOpen();
          assertNonNegativeSafeInteger({ value: offset, fieldName: 'Buffer offset' });
          assertNonNegativeSafeInteger({ value: length, fieldName: 'Read length' });
          assertNonNegativeSafeInteger({ value: position, fieldName: 'Read position' });
          signal?.throwIfAborted();
          if (length === 0 || position >= manifest.size || offset >= buffer.byteLength) {
            return { bytesRead: 0 };
          }
          const requestedEnd = Math.min(
            position + length,
            manifest.size,
            position + buffer.byteLength - offset,
          );
          let currentPosition = position;
          let targetOffset = offset;
          buffer.fill(0, offset, offset + requestedEnd - position);
          while (currentPosition < requestedEnd) {
            signal?.throwIfAborted();
            const chunkIndex = Math.floor(currentPosition / manifest.chunkSize);
            const chunkStart = chunkIndex * manifest.chunkSize;
            const sourceStart = currentPosition - chunkStart;
            const segmentLength = Math.min(
              requestedEnd - currentPosition,
              manifest.chunkSize - sourceStart,
            );
            const chunkId = await getChunkId({ chunkIndex });
            if (chunkId !== null) {
              const plaintext = await this.readChunk({ chunkId });
              const expectedChunkLength = getChunkLength({
                size: manifest.size,
                chunkSize: manifest.chunkSize,
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
                buffer.set(plaintext.subarray(sourceStart, sourceStart + available), targetOffset);
              }
            }
            currentPosition += segmentLength;
            targetOffset += segmentLength;
          }
          return { bytesRead: requestedEnd - position };
        };
        return {
          size: manifest.size,
          mimeType,
          backing: { type: 'reader_only' },
          read: readRange,
          stream({ start, end, signal }) {
            const finalEnd = Math.min(end ?? manifest.size, manifest.size);
            let position = Math.min(start, finalEnd);
            return new ReadableStream<Uint8Array>({
              async pull(controller) {
                if (position >= finalEnd) {
                  controller.close();
                  return;
                }
                const buffer = new Uint8Array(Math.min(manifest.chunkSize, finalEnd - position));
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
          async close() {
            if (closed) {
              return;
            }
            closed = true;
            historyLease.release();
            await historyLease.completion;
            requestPendingCleanup();
          },
        };
      },
    });
  }

  async delete({ fileId }: { fileId: string }): Promise<void> {
    const coordinator = await this.getCoordinator({ fileId });
    await coordinator.mutate({
      prepare: async () => {
        const manifest = await this.readManifestUnsafe({ fileId });
        return {
          operations: manifest === undefined
            ? []
            : [{ type: 'delete' as const, locator: this.getManifestLocator({ fileId }) }],
          cleanupAfterCommit: manifest === undefined
            ? undefined
            : async () => this.scheduleReplacedManifestCleanup({ manifest }),
        };
      },
      result: async () => undefined,
    });
  }

  async readManifest({
    fileId,
  }: {
    fileId: string,
  }): Promise<EncryptedFileManifestDto | undefined> {
    const coordinator = await this.getCoordinator({ fileId });
    return await coordinator.read({
      run: async () => await this.readManifestUnsafe({ fileId }),
    });
  }

  private async readManifestUnsafe({
    fileId,
  }: {
    fileId: string,
  }): Promise<EncryptedFileManifestDto | undefined> {
    const bytes = await this.objectStore.read({
      locator: this.getManifestLocator({ fileId }),
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

  private async writeChunkMapPages({
    fileId,
    chunkIds,
    onPageCreated,
  }: {
    fileId: string,
    chunkIds: Array<string | null>,
    onPageCreated: ({ pageId }: { pageId: string }) => void,
  }): Promise<string[]> {
    const pageIds: string[] = [];
    for (let offset = 0; offset < chunkIds.length; offset += DEFAULT_CHUNK_MAP_PAGE_SIZE) {
      const pageId = createOpaqueId();
      const pageIndex = pageIds.length;
      const page: EncryptedFileChunkMapPageDto = {
        pageId,
        fileId,
        pageIndex,
        chunkIds: chunkIds.slice(offset, offset + DEFAULT_CHUNK_MAP_PAGE_SIZE),
      };
      await this.objectStore.write({
        locator: { namespace: 'file_chunk_map_page', key: pageId },
        plaintext: UTF8.encode(JSON.stringify(page)),
      });
      pageIds.push(pageId);
      onPageCreated({ pageId });
    }
    return pageIds;
  }

  private async readChunkMapPage({
    manifest,
    pageIndex,
  }: {
    manifest: EncryptedFileManifestDto,
    pageIndex: number,
  }): Promise<EncryptedFileChunkMapPageDto> {
    const pageId = manifest.chunkMapPageIds[pageIndex];
    if (pageId === undefined) {
      throw new Error(`Encrypted file chunk-map page is out of range: ${manifest.fileId}/${pageIndex}`);
    }
    const bytes = await this.objectStore.read({
      locator: { namespace: 'file_chunk_map_page', key: pageId },
    });
    if (bytes === undefined) {
      throw new Error(`Encrypted file chunk-map page is missing: ${pageId}`);
    }
    const page = EncryptedFileChunkMapPageSchemaDto.parse(
      JSON.parse(UTF8_DECODER.decode(bytes)),
    );
    assertChunkMapPage({ page, manifest, pageIndex });
    return page;
  }

  private async readAllChunkIds({
    manifest,
  }: {
    manifest: EncryptedFileManifestDto,
  }): Promise<Array<string | null>> {
    const chunkIds: Array<string | null> = [];
    const seenChunkIds = new Set<string>();
    for (let pageIndex = 0; pageIndex < manifest.chunkMapPageIds.length; pageIndex++) {
      const page = await this.readChunkMapPage({ manifest, pageIndex });
      for (const chunkId of page.chunkIds) {
        if (chunkId !== null) {
          if (seenChunkIds.has(chunkId)) {
            throw new Error(`Encrypted file chunk-map aliases a chunk: ${manifest.fileId}/${chunkId}`);
          }
          seenChunkIds.add(chunkId);
        }
        chunkIds.push(chunkId);
      }
    }
    return chunkIds;
  }

  private async writeNewChunk({ plaintext }: { plaintext: Uint8Array }): Promise<string> {
    const chunkId = createOpaqueId();
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

  private getManifestLocator({ fileId }: { fileId: string }) {
    return { namespace: 'file_manifest', key: fileId } as const;
  }

  private async getCoordinator({
    fileId,
  }: {
    fileId: string,
  }): Promise<EncryptedObjectTransactionCoordinator> {
    let coordinator = this.coordinators.get(fileId);
    if (coordinator === undefined) {
      coordinator = this.objectStore.getObjectId({ locator: this.getManifestLocator({ fileId }) })
        .then(objectId => new EncryptedObjectTransactionCoordinator({
          objectStore: this.objectStore,
          scopeId: `file/${fileId}`,
          lockName: `naidan/opfs-encryption/file/${objectId}`,
        }));
      this.coordinators.set(fileId, coordinator);
    }
    return await coordinator;
  }

  private async getFileHistoryLockName({
    fileId,
  }: {
    fileId: string,
  }): Promise<string> {
    const objectId = await this.objectStore.getObjectId({
      locator: this.getManifestLocator({ fileId }),
    });
    return `naidan/opfs-encryption/file-history/${objectId}`;
  }

  private scheduleReplacedManifestCleanup({
    manifest,
  }: {
    manifest: EncryptedFileManifestDto,
  }): void {
    let pending = this.pendingCleanupManifests.get(manifest.fileId);
    if (pending === undefined) {
      pending = new Map();
      this.pendingCleanupManifests.set(manifest.fileId, pending);
    }
    pending.set(manifest.revision, manifest);
    this.requestPendingCleanup({ fileId: manifest.fileId });
  }

  private requestPendingCleanup({
    fileId,
  }: {
    fileId: string,
  }): void {
    if (this.cleanupAttempts.has(fileId)) {
      this.cleanupRetryRequests.add(fileId);
      return;
    }
    const attempt = (async () => {
      do {
        this.cleanupRetryRequests.delete(fileId);
        await this.tryCleanupPendingManifests({ fileId });
      } while (this.cleanupRetryRequests.delete(fileId));
    })().catch((error) => {
      console.warn('Encrypted file cleanup scheduling failed', error);
    }).finally(() => {
      this.cleanupAttempts.delete(fileId);
    });
    this.cleanupAttempts.set(fileId, attempt);
  }

  private async tryCleanupPendingManifests({
    fileId,
  }: {
    fileId: string,
  }): Promise<void> {
    const coordinator = await this.getCoordinator({ fileId });
    await coordinator.mutate({
      prepare: async () => {
        const historyLease = await tryAcquireEncryptedStorageLock({
          lockName: await this.getFileHistoryLockName({ fileId }),
          mode: 'exclusive',
        });
        if (historyLease === undefined) {
          // Cleanup is strictly post-commit work. Never queue an exclusive lock
          // behind open readers, because that would also prevent later readers
          // from opening the already-committed current revision.
          return { operations: [] };
        }
        try {
          const pending = this.pendingCleanupManifests.get(fileId);
          if (pending === undefined || pending.size === 0) {
            return { operations: [] };
          }
          const currentManifest = await this.readManifestUnsafe({ fileId });
          for (const [revision, manifest] of [...pending]) {
            await this.cleanupReplacedManifest({ manifest, currentManifest });
            pending.delete(revision);
          }
          if (pending.size === 0) {
            this.pendingCleanupManifests.delete(fileId);
          }
        } finally {
          historyLease.release();
          await historyLease.completion;
        }
        return { operations: [] };
      },
      result: async () => undefined,
    });
  }

  private async cleanupReplacedManifest({
    manifest,
    currentManifest,
  }: {
    manifest: EncryptedFileManifestDto,
    currentManifest: EncryptedFileManifestDto | undefined,
  }): Promise<void> {
    try {
      const oldChunkIds = await this.readAllChunkIds({ manifest });
      const currentChunkIds = currentManifest === undefined
        ? []
        : await this.readAllChunkIds({ manifest: currentManifest });
      const retainedChunkIds = new Set(
        currentChunkIds.filter((chunkId): chunkId is string => chunkId !== null),
      );
      const retainedPageIds = new Set(currentManifest?.chunkMapPageIds ?? []);
      await this.deleteChunks({
        chunkIds: oldChunkIds.filter(
          (chunkId): chunkId is string => chunkId !== null && !retainedChunkIds.has(chunkId),
        ),
      });
      await this.deleteChunkMapPages({
        pageIds: manifest.chunkMapPageIds.filter(pageId => !retainedPageIds.has(pageId)),
      });
    } catch (error) {
      // The manifest replacement is the commit point. Cleanup failures leave
      // unreachable encrypted objects and must not invalidate the committed file.
      console.warn('Encrypted file cleanup failed', error);
    }
  }

  private async deleteChunks({ chunkIds }: { chunkIds: string[] }): Promise<void> {
    for (const chunkId of new Set(chunkIds)) {
      await this.objectStore.delete({ locator: { namespace: 'file_chunk', key: chunkId } });
    }
  }

  private async deleteChunkMapPages({ pageIds }: { pageIds: string[] }): Promise<void> {
    for (const pageId of new Set(pageIds)) {
      await this.objectStore.delete({
        locator: { namespace: 'file_chunk_map_page', key: pageId },
      });
    }
  }
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
  DEFAULT_CHUNK_MAP_PAGE_SIZE,
  DEFAULT_CHUNK_SIZE,
  assertChunkMapPage,
  assertFileManifest,
  getChunkCount,
  getChunkMapPageCount,
  writeStreamChunks,
};
