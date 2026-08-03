import { describe, expect, it } from "vitest";
import {
  HIZOFS_V1_FORMAT_CONSTANTS,
  createHomeRecordReference,
  createUInt64,
  parseSegmentId,
  type HomeRecordReference,
} from "@/00-storage/service/hizofs/00-format";
import {
  AuthenticatedMetadataRecordCache,
  type AuthenticatedMetadataRecord,
} from "@/00-storage/service/hizofs/authenticated-store/metadata-record-cache";
import type { AuthenticatedStoreDiagnosticsPort } from "@/00-storage/service/hizofs/authenticated-store/diagnostics-hooks";

type MetadataDiagnosticsState = {
  currentBytes: number;
  currentEntries: number;
  evictions: number;
  hits: number;
  misses: number;
};

function createMetadataDiagnostics(): {
  diagnostics: AuthenticatedStoreDiagnosticsPort;
  state: MetadataDiagnosticsState;
  } {
  const state: MetadataDiagnosticsState = {
    currentBytes: 0,
    currentEntries: 0,
    evictions: 0,
    hits: 0,
    misses: 0,
  };
  return {
    diagnostics: {
      recordCodecOperation: () => {},
      recordCryptoOperation: () => {},
      recordMetadataCacheEvent: ({ event }) => {
        switch (event) {
        case "eviction": state.evictions += 1; break;
        case "hit": state.hits += 1; break;
        case "miss": state.misses += 1; break;
        default: return event satisfies never;
        }
      },
      recordPersistedRecord: () => undefined,
      recordPublicationOperation: () => {},
      setMetadataCacheUsage: ({ bytes, entries }) => {
        state.currentBytes = bytes;
        state.currentEntries = entries;
      },
    },
    state,
  };
}

function metadataReference({ offset = 64n, seed = 1 }: {
  offset?: bigint;
  seed?: number;
} = {}): HomeRecordReference {
  return createHomeRecordReference({ fields: {
    byteOffset: createUInt64({ value: offset }),
    frameLength: 96,
    recordKind: HIZOFS_V1_FORMAT_CONSTANTS.recordKinds.inode_table_page,
    segmentId: parseSegmentId({ bytes: new Uint8Array(16).fill(seed) }),
  } });
}

function fileDataReference(): HomeRecordReference {
  return createHomeRecordReference({ fields: {
    byteOffset: createUInt64({ value: 64n }),
    frameLength: 96,
    recordKind: HIZOFS_V1_FORMAT_CONSTANTS.recordKinds.file_data,
    segmentId: parseSegmentId({ bytes: new Uint8Array(16).fill(9) }),
  } });
}

function loadedRecord({ bytes, reference }: {
  bytes: number[];
  reference: HomeRecordReference;
}): AuthenticatedMetadataRecord {
  return {
    plaintext: new Uint8Array(bytes),
    recordKind: reference.recordKind,
  };
}

describe("AuthenticatedMetadataRecordCache", () => {

  it("rejects invalid resource bounds before accepting authenticated plaintext", () => {
    expect(() => new AuthenticatedMetadataRecordCache({
      diagnostics: undefined,
      policy: { maximumBytes: -1, maximumEntries: 1 },
    })).toThrow("non-negative safe integer");
    expect(() => new AuthenticatedMetadataRecordCache({
      diagnostics: undefined,
      policy: { maximumBytes: 1, maximumEntries: Number.MAX_SAFE_INTEGER + 1 },
    })).toThrow("non-negative safe integer");
  });

  it("returns detached plaintext while retaining authenticated immutable metadata", async () => {
    const { diagnostics, state } = createMetadataDiagnostics();
    const cache = new AuthenticatedMetadataRecordCache({
      diagnostics,
      policy: { maximumBytes: 32, maximumEntries: 4 },
    });
    const reference = metadataReference();
    let loads = 0;
    const load = async (): Promise<AuthenticatedMetadataRecord> => {
      loads += 1;
      return loadedRecord({ bytes: [1, 2, 3], reference });
    };

    const first = await cache.read({ load, reference });
    first.plaintext.fill(0);
    const second = await cache.read({ load, reference });

    expect(loads).toBe(1);
    expect([...second.plaintext]).toEqual([1, 2, 3]);
    expect(second.plaintext).not.toBe(first.plaintext);
    expect(state).toMatchObject({
      currentBytes: 3,
      currentEntries: 1,
      hits: 1,
      misses: 1,
    });

    cache.clear();
    expect(state).toMatchObject({
      currentBytes: 0,
      currentEntries: 0,
    });
  });

  it("returns oversized authenticated metadata without retaining it", async () => {
    const { diagnostics, state } = createMetadataDiagnostics();
    const cache = new AuthenticatedMetadataRecordCache({
      diagnostics,
      policy: { maximumBytes: 2, maximumEntries: 4 },
    });
    const reference = metadataReference();
    let loads = 0;
    const load = async (): Promise<AuthenticatedMetadataRecord> => {
      loads += 1;
      return loadedRecord({ bytes: [1, 2, 3], reference });
    };

    const first = await cache.read({ load, reference });
    const second = await cache.read({ load, reference });

    expect([...first.plaintext]).toEqual([1, 2, 3]);
    expect([...second.plaintext]).toEqual([1, 2, 3]);
    expect(loads).toBe(2);
    expect(state).toMatchObject({
      currentBytes: 0,
      currentEntries: 0,
      hits: 0,
      misses: 2,
    });
  });

  it("uses bounded LRU eviction and never retains file-data plaintext", async () => {
    const { diagnostics, state } = createMetadataDiagnostics();
    const cache = new AuthenticatedMetadataRecordCache({
      diagnostics,
      policy: { maximumBytes: 4, maximumEntries: 2 },
    });
    const firstReference = metadataReference({ seed: 1 });
    const secondReference = metadataReference({ seed: 2 });
    const thirdReference = metadataReference({ seed: 3 });
    const loadCounts = new Map<number, number>();
    const read = async ({ reference, seed }: {
      reference: HomeRecordReference;
      seed: number;
    }): Promise<void> => {
      await cache.read({
        load: async () => {
          loadCounts.set(seed, (loadCounts.get(seed) ?? 0) + 1);
          return loadedRecord({ bytes: [seed, seed], reference });
        },
        reference,
      });
    };

    await read({ reference: firstReference, seed: 1 });
    await read({ reference: secondReference, seed: 2 });
    await read({ reference: firstReference, seed: 1 });
    await read({ reference: thirdReference, seed: 3 });
    await read({ reference: secondReference, seed: 2 });

    const fileReference = fileDataReference();
    let fileLoads = 0;
    const loadFile = async (): Promise<AuthenticatedMetadataRecord> => {
      fileLoads += 1;
      return loadedRecord({ bytes: [7], reference: fileReference });
    };
    await cache.read({ load: loadFile, reference: fileReference });
    await cache.read({ load: loadFile, reference: fileReference });

    expect(loadCounts).toEqual(new Map([[1, 1], [2, 2], [3, 1]]));
    expect(fileLoads).toBe(2);
    expect(state).toMatchObject({
      currentBytes: 4,
      currentEntries: 2,
      evictions: 2,
      hits: 1,
      misses: 4,
    });
  });

  it("coalesces concurrent insertion accounting without sharing caller buffers", async () => {
    const { diagnostics, state } = createMetadataDiagnostics();
    const cache = new AuthenticatedMetadataRecordCache({
      diagnostics,
      policy: { maximumBytes: 32, maximumEntries: 4 },
    });
    const reference = metadataReference();
    const resolvers: Array<(record: AuthenticatedMetadataRecord) => void> = [];
    const load = (): Promise<AuthenticatedMetadataRecord> => new Promise(resolve => resolvers.push(resolve));

    const firstPromise = cache.read({ load, reference });
    const secondPromise = cache.read({ load, reference });
    await Promise.resolve();
    expect(resolvers).toHaveLength(2);
    const [resolveFirst, resolveSecond] = resolvers;
    if (resolveFirst === undefined || resolveSecond === undefined) {
      throw new Error("expected two concurrent metadata loaders");
    }
    resolveFirst(loadedRecord({ bytes: [4, 5], reference }));
    const first = await firstPromise;
    resolveSecond(loadedRecord({ bytes: [8, 9], reference }));
    const second = await secondPromise;

    expect([...first.plaintext]).toEqual([4, 5]);
    expect([...second.plaintext]).toEqual([4, 5]);
    expect(first.plaintext).not.toBe(second.plaintext);
    expect(state).toMatchObject({
      currentBytes: 2,
      currentEntries: 1,
      misses: 2,
    });
  });

  it("zeroes a pending load and rejects future reads after disposal", async () => {
    const { diagnostics, state } = createMetadataDiagnostics();
    const cache = new AuthenticatedMetadataRecordCache({
      diagnostics,
      policy: { maximumBytes: 32, maximumEntries: 4 },
    });
    const reference = metadataReference();
    let resolveLoad: ((record: AuthenticatedMetadataRecord) => void) | undefined;
    const plaintext = new Uint8Array([6, 7, 8]);
    const pending = cache.read({
      load: async () => await new Promise(resolve => {
        resolveLoad = resolve;
      }),
      reference,
    });
    await Promise.resolve();

    cache.dispose();
    resolveLoad?.({ plaintext, recordKind: reference.recordKind });

    await expect(pending).rejects.toThrow("disposed while loading");
    expect([...plaintext]).toEqual([0, 0, 0]);
    await expect(cache.read({
      load: async () => loadedRecord({ bytes: [1], reference }),
      reference,
    })).rejects.toThrow("cache is disposed");
    expect(state).toMatchObject({
      currentBytes: 0,
      currentEntries: 0,
    });
  });

  it("rejects a loader result whose authenticated Record Kind contradicts its reference", async () => {
    const cache = new AuthenticatedMetadataRecordCache({
      diagnostics: undefined,
      policy: { maximumBytes: 32, maximumEntries: 4 },
    });
    const reference = metadataReference();
    const plaintext = new Uint8Array([1, 2, 3]);

    await expect(cache.read({
      load: async () => ({
        plaintext,
        recordKind: HIZOFS_V1_FORMAT_CONSTANTS.recordKinds.directory_page,
      }),
      reference,
    })).rejects.toThrow("wrong Record Kind");
    expect([...plaintext]).toEqual([0, 0, 0]);
  });
});
