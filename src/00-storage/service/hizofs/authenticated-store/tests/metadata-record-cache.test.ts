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
  TEST_ONLY as METADATA_CACHE_TEST_ONLY,
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

  it("uses complete collision-free Record Reference fields for runtime cache identity", () => {
    const base = metadataReference({ offset: 64n, seed: 1 });
    const equal = metadataReference({ offset: 64n, seed: 1 });
    const differentSegment = metadataReference({ offset: 64n, seed: 2 });
    const differentOffset = metadataReference({ offset: 160n, seed: 1 });
    const differentLength = createHomeRecordReference({ fields: { ...base, frameLength: 104 } });
    const differentKind = createHomeRecordReference({ fields: {
      ...base,
      recordKind: HIZOFS_V1_FORMAT_CONSTANTS.recordKinds.directory_page,
    } });
    const identity = METADATA_CACHE_TEST_ONLY.referenceIdentity({ reference: base });
    expect(METADATA_CACHE_TEST_ONLY.referenceIdentity({ reference: equal })).toBe(identity);
    for (const reference of [differentSegment, differentOffset, differentLength, differentKind]) {
      expect(METADATA_CACHE_TEST_ONLY.referenceIdentity({ reference })).not.toBe(identity);
    }
    expect(() => METADATA_CACHE_TEST_ONLY.referenceIdentity({
      reference: { ...base, frameLength: 89 } as HomeRecordReference,
    })).toThrow("aligned");
  });

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

  it("requires two read observations before mutation scope retains loaded plaintext", async () => {
    const { diagnostics, state } = createMetadataDiagnostics();
    const cache = new AuthenticatedMetadataRecordCache({
      diagnosticScope: "mutation",
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
    expect(state.currentEntries).toBe(0);
    const second = await cache.read({ load, reference });
    second.plaintext.fill(0);
    expect(state.currentEntries).toBe(1);
    const third = await cache.read({ load, reference });
    third.plaintext.fill(0);

    expect(loads).toBe(2);
    expect(state).toMatchObject({ hits: 1, misses: 2 });
  });

  it("retains mutation-scope authenticated writes immediately", async () => {
    const { diagnostics, state } = createMetadataDiagnostics();
    const cache = new AuthenticatedMetadataRecordCache({
      diagnosticScope: "mutation",
      diagnostics,
      policy: { maximumBytes: 32, maximumEntries: 4 },
    });
    const reference = metadataReference();
    cache.admitAuthenticatedWrite({
      plaintext: new Uint8Array([4, 5, 6]),
      recordKind: reference.recordKind,
      reference,
    });
    const value = await cache.read({
      load: async () => {
        throw new Error("write-admitted metadata was not retained");
      },
      reference,
    });
    expect([...value.plaintext]).toEqual([4, 5, 6]);
    value.plaintext.fill(0);
    expect(state).toMatchObject({ currentEntries: 1, hits: 1, misses: 0 });
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

  it("serves a successfully written immutable metadata record without reloading physical storage", async () => {
    const { diagnostics, state } = createMetadataDiagnostics();
    const cache = new AuthenticatedMetadataRecordCache({
      diagnostics,
      policy: { maximumBytes: 32, maximumEntries: 4 },
    });
    const reference = metadataReference();
    const writtenPlaintext = new Uint8Array([9, 8, 7]);

    cache.admitAuthenticatedWrite({
      plaintext: writtenPlaintext,
      recordKind: reference.recordKind,
      reference,
    });
    writtenPlaintext.fill(0);
    let loads = 0;
    const read = await cache.read({
      load: async () => {
        loads += 1;
        return loadedRecord({ bytes: [1, 2, 3], reference });
      },
      reference,
    });

    expect(loads).toBe(0);
    expect([...read.plaintext]).toEqual([9, 8, 7]);
    expect(state).toMatchObject({
      currentBytes: 3,
      currentEntries: 1,
      hits: 1,
      misses: 0,
    });
  });

  it("rejects conflicting write admission for one immutable Home Record Reference", () => {
    const cache = new AuthenticatedMetadataRecordCache({
      diagnostics: undefined,
      policy: { maximumBytes: 32, maximumEntries: 4 },
    });
    const reference = metadataReference();
    cache.admitAuthenticatedWrite({
      plaintext: new Uint8Array([1, 2]),
      recordKind: reference.recordKind,
      reference,
    });

    expect(() => cache.admitAuthenticatedWrite({
      plaintext: new Uint8Array([1, 3]),
      recordKind: reference.recordKind,
      reference,
    })).toThrow("conflicts with retained immutable plaintext");
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

  it("coalesces concurrent authenticated loads without sharing caller buffers", async () => {
    const { diagnostics, state } = createMetadataDiagnostics();
    const cache = new AuthenticatedMetadataRecordCache({
      diagnostics,
      policy: { maximumBytes: 128, maximumEntries: 4 },
    });
    const reference = metadataReference();
    const resolvers: Array<(record: AuthenticatedMetadataRecord) => void> = [];
    const load = (): Promise<AuthenticatedMetadataRecord> => new Promise(resolve => resolvers.push(resolve));

    const firstPromise = cache.read({ load, reference });
    const secondPromise = cache.read({ load, reference });
    await Promise.resolve();
    expect(resolvers).toHaveLength(1);
    const [resolveLoad] = resolvers;
    if (resolveLoad === undefined) throw new Error("expected one shared metadata loader");
    resolveLoad(loadedRecord({ bytes: [4, 5], reference }));
    const [first, second] = await Promise.all([firstPromise, secondPromise]);

    expect([...first.plaintext]).toEqual([4, 5]);
    expect([...second.plaintext]).toEqual([4, 5]);
    expect(first.plaintext).not.toBe(second.plaintext);
    expect(state).toMatchObject({
      currentBytes: 2,
      currentEntries: 1,
      hits: 1,
      misses: 2,
    });
  });

  it("does not single-flight a frame outside the cache byte budget", async () => {
    const cache = new AuthenticatedMetadataRecordCache({
      diagnostics: undefined,
      policy: { maximumBytes: 32, maximumEntries: 4 },
    });
    const reference = metadataReference();
    const resolvers: Array<(record: AuthenticatedMetadataRecord) => void> = [];
    const load = async (): Promise<AuthenticatedMetadataRecord> => await new Promise(resolve => {
      resolvers.push(resolve);
    });

    const first = cache.read({ load, reference });
    const second = cache.read({ load, reference });
    await Promise.resolve();
    expect(resolvers).toHaveLength(2);
    resolvers[0]?.(loadedRecord({ bytes: [1, 2], reference }));
    resolvers[1]?.(loadedRecord({ bytes: [3, 4], reference }));
    await Promise.all([first, second]);
  });

  it("promotes a concurrent mutation-scope miss so later readers reuse one authenticated load", async () => {
    const cache = new AuthenticatedMetadataRecordCache({
      diagnosticScope: "mutation",
      diagnostics: undefined,
      policy: { maximumBytes: 128, maximumEntries: 4 },
    });
    const reference = metadataReference();
    let loads = 0;
    let resolveLoad: ((record: AuthenticatedMetadataRecord) => void) | undefined;
    const load = async (): Promise<AuthenticatedMetadataRecord> => {
      loads += 1;
      return await new Promise(resolve => {
        resolveLoad = resolve;
      });
    };

    const first = cache.read({ load, reference });
    const second = cache.read({ load, reference });
    await Promise.resolve();
    expect(loads).toBe(1);
    resolveLoad?.(loadedRecord({ bytes: [2, 4], reference }));
    await Promise.all([first, second]);
    await cache.read({ load, reference });

    expect(loads).toBe(1);
  });

  it("shares one load failure with concurrent readers and permits a clean retry", async () => {
    const cache = new AuthenticatedMetadataRecordCache({
      diagnostics: undefined,
      policy: { maximumBytes: 128, maximumEntries: 4 },
    });
    const reference = metadataReference();
    let loads = 0;
    let rejectLoad: ((cause: unknown) => void) | undefined;
    const failingLoad = async (): Promise<AuthenticatedMetadataRecord> => {
      loads += 1;
      return await new Promise((_, reject) => {
        rejectLoad = reject;
      });
    };

    const first = cache.read({ load: failingLoad, reference });
    const second = cache.read({ load: failingLoad, reference });
    const firstFailure = expect(first).rejects.toThrow("shared load failed");
    const secondFailure = expect(second).rejects.toThrow("shared load failed");
    await Promise.resolve();
    expect(loads).toBe(1);
    rejectLoad?.(new Error("shared load failed"));
    await firstFailure;
    await secondFailure;

    await expect(cache.read({
      load: async () => loadedRecord({ bytes: [7, 8], reference }),
      reference,
    })).resolves.toMatchObject({ recordKind: reference.recordKind });
  });

  it("zeroes a pending load and rejects future reads after disposal", async () => {
    const { diagnostics, state } = createMetadataDiagnostics();
    const cache = new AuthenticatedMetadataRecordCache({
      diagnostics,
      policy: { maximumBytes: 128, maximumEntries: 4 },
    });
    const reference = metadataReference();
    let loads = 0;
    let resolveLoad: ((record: AuthenticatedMetadataRecord) => void) | undefined;
    const plaintext = new Uint8Array([6, 7, 8]);
    const load = async (): Promise<AuthenticatedMetadataRecord> => {
      loads += 1;
      return await new Promise(resolve => {
        resolveLoad = resolve;
      });
    };
    const pending = cache.read({ load, reference });
    const follower = cache.read({ load, reference });
    const pendingFailure = expect(pending).rejects.toThrow("disposed while loading");
    const followerFailure = expect(follower).rejects.toThrow("disposed while loading");
    await Promise.resolve();
    expect(loads).toBe(1);

    cache.dispose();
    resolveLoad?.({ plaintext, recordKind: reference.recordKind });

    await pendingFailure;
    await followerFailure;
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
