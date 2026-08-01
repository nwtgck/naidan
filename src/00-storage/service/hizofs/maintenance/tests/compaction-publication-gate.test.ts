import { describe, expect, it } from "vitest";
import {
  HIZOFS_V1_FORMAT_CONSTANTS,
  createPhysicalRecordReference,
  createUInt64,
  parseSegmentId,
} from "@/00-storage/service/hizofs/00-format";
import {
  CompactionPublicationGate,
  CompactionPublicationGateError,
} from "@/00-storage/service/hizofs/maintenance/compaction-publication-gate";

function segmentId({ seed }: { seed: number }) {
  return parseSegmentId({ bytes: new Uint8Array(16).fill(seed) });
}

function relocationRoot({ seed = 9 }: { seed?: number } = {}) {
  return createPhysicalRecordReference({ fields: {
    byteOffset: createUInt64({ value: 64n }),
    frameLength: 96,
    recordKind: HIZOFS_V1_FORMAT_CONSTANTS.recordKinds.relocation_index_page,
    segmentId: segmentId({ seed }),
  } });
}

describe("compaction publication gate", () => {
  it("protects source segments until destination, tree, revalidation, and both copies converge", () => {
    const gate = new CompactionPublicationGate({ sourceSegmentIds: [segmentId({ seed: 2 }), segmentId({ seed: 1 })] });
    expect(gate.phase).toBe("copying");
    expect(() => gate.sourceSegmentsEligibleForLaterGc()).toThrowError(CompactionPublicationGateError);
    gate.markDestinationFramesDurable();
    gate.markRelocationIndexDurable({ rootPhysicalReference: relocationRoot() });
    gate.markRootsRevalidated();
    gate.markPublicationStarted();
    gate.markCopiesConverged({ publishedRelocationRootPhysicalReference: relocationRoot() });
    expect(gate.phase).toBe("converged");
    const eligible = gate.sourceSegmentsEligibleForLaterGc();
    expect(eligible.map(value => value[0])).toEqual([1, 2]);
    eligible[0]?.fill(99);
    expect(gate.sourceSegmentsEligibleForLaterGc()[0]?.[0]).toBe(1);
  });

  it("fails closed on skipped transitions, duplicate source identity, or wrong published root", () => {
    expect(() => new CompactionPublicationGate({
      sourceSegmentIds: [segmentId({ seed: 1 }), segmentId({ seed: 1 })],
    })).toThrowError(CompactionPublicationGateError);
    const gate = new CompactionPublicationGate({ sourceSegmentIds: [segmentId({ seed: 1 })] });
    expect(() => gate.markRelocationIndexDurable({ rootPhysicalReference: relocationRoot() }))
      .toThrowError(CompactionPublicationGateError);
    gate.markDestinationFramesDurable();
    gate.markRelocationIndexDurable({ rootPhysicalReference: relocationRoot() });
    gate.markRootsRevalidated();
    gate.markPublicationStarted();
    expect(() => gate.markCopiesConverged({ publishedRelocationRootPhysicalReference: relocationRoot({ seed: 10 }) }))
      .toThrowError(CompactionPublicationGateError);
    expect(gate.phase).toBe("aborted");
    expect(() => gate.sourceSegmentsEligibleForLaterGc()).toThrowError(CompactionPublicationGateError);
  });

  it("can abort from an intermediate phase without making source deletion eligible", () => {
    const gate = new CompactionPublicationGate({ sourceSegmentIds: [segmentId({ seed: 1 })] });
    gate.markDestinationFramesDurable();
    gate.abort();
    gate.abort();
    expect(gate.phase).toBe("aborted");
    expect(() => gate.markRelocationIndexDurable({ rootPhysicalReference: relocationRoot() }))
      .toThrowError(CompactionPublicationGateError);
  });

  it("waits for runtime references to drain before returning source deletion leases", async () => {
    const gate = new CompactionPublicationGate({ sourceSegmentIds: [segmentId({ seed: 1 })] });
    gate.markDestinationFramesDurable();
    gate.markRelocationIndexDurable({ rootPhysicalReference: relocationRoot() });
    gate.markRootsRevalidated();
    gate.markPublicationStarted();
    gate.markCopiesConverged({ publishedRelocationRootPhysicalReference: relocationRoot() });
    let releaseWaiter: (() => void) | undefined;
    let ready = false;
    const leasesPromise = gate.prepareSourceDeletionLeases({
      beginDeletion: async () => await new Promise(resolve => {
        releaseWaiter = () => resolve({ release: () => undefined });
      }),
    }).then(leases => {
      ready = true;
      return leases;
    });
    await Promise.resolve();
    expect(ready).toBe(false);
    releaseWaiter?.();
    const leases = await leasesPromise;
    expect(leases).toHaveLength(1);
    expect(leases[0]?.segmentId[0]).toBe(1);
  });

});
