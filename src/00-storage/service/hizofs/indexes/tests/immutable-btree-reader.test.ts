import { describe, expect, it } from "vitest";
import {
  ImmutableBTreeReader,
  type ImmutableBTreePage,
} from "@/00-storage/service/hizofs/indexes/immutable-btree-reader";
import type {
  ImmutableBTreeDiagnosticsObservation,
  ImmutableBTreeDiagnosticsPort,
} from "@/00-storage/service/hizofs/indexes/diagnostics-hooks";

type Entry = Readonly<{ key: number; value: string }>;
type Page = ImmutableBTreePage<number, Entry, string>;

function reader({ operationDiagnostics, pages }: {
  operationDiagnostics?: ImmutableBTreeDiagnosticsPort;
  pages: ReadonlyMap<string, Page>;
}): ImmutableBTreeReader<number, Entry, string> {
  return new ImmutableBTreeReader({
    compareKeys: ({ left, right }) => left - right,
    getEntryKey: ({ entry }) => entry.key,
    operationDiagnostics,
    pageReader: async ({ reference }) => {
      const page = pages.get(reference);
      if (page === undefined) throw new Error(`missing page ${reference}`);
      return page;
    },
    referenceIdentity: ({ reference }) => reference,
  });
}

function twoLeafTree(): ReadonlyMap<string, Page> {
  return new Map([
    ["root", {
      children: [
        { childPageReference: "left", upperBound: 20 },
        { childPageReference: "right", upperBound: 50 },
      ],
      level: 1,
      type: "branch",
    }],
    ["left", {
      entries: [
        { key: 10, value: "ten" },
        { key: 20, value: "twenty" },
      ],
      level: 0,
      type: "leaf",
    }],
    ["right", {
      entries: [
        { key: 30, value: "thirty" },
        { key: 50, value: "fifty" },
      ],
      level: 0,
      type: "leaf",
    }],
  ]);
}

describe("immutable B-tree reader", () => {
  it("performs exact lookup without treating an upper-bound child selection as a match", async () => {
    const index = reader({ pages: twoLeafTree() });
    await expect(index.get({ key: 20, rootReference: "root" })).resolves.toEqual({ key: 20, value: "twenty" });
    await expect(index.get({ key: 25, rootReference: "root" })).resolves.toBeUndefined();
    await expect(index.get({ key: 60, rootReference: "root" })).resolves.toBeUndefined();
  });

  it("seekFloor falls back to the previous child when the selected child starts after the key", async () => {
    const index = reader({ pages: twoLeafTree() });
    await expect(index.seekFloor({ key: 25, rootReference: "root" })).resolves.toEqual({ key: 20, value: "twenty" });
    await expect(index.seekFloor({ key: 30, rootReference: "root" })).resolves.toEqual({ key: 30, value: "thirty" });
    await expect(index.seekFloor({ key: 5, rootReference: "root" })).resolves.toBeUndefined();
    const beforeFirst: Entry[] = [];
    for await (const entry of index.entriesFromFloor({ key: 5, rootReference: "root" })) beforeFirst.push(entry);
    expect(beforeFirst).toEqual([
      { key: 10, value: "ten" },
      { key: 20, value: "twenty" },
      { key: 30, value: "thirty" },
      { key: 50, value: "fifty" },
    ]);
    await expect(index.seekFloor({ key: 99, rootReference: "root" })).resolves.toEqual({ key: 50, value: "fifty" });
  });

  it("iterates from the floor entry and then follows strict successors", async () => {
    const index = reader({ pages: twoLeafTree() });
    const entries: Entry[] = [];
    for await (const entry of index.entriesFromFloor({ key: 25, rootReference: "root" })) entries.push(entry);
    expect(entries).toEqual([
      { key: 20, value: "twenty" },
      { key: 30, value: "thirty" },
      { key: 50, value: "fifty" },
    ]);
  });

  it("continues a floor seek without repeating the located path", async () => {
    const observations: ImmutableBTreeDiagnosticsObservation[] = [];
    const index = reader({
      operationDiagnostics: {
        recordIndexOperation: observation => observations.push(observation),
      },
      pages: twoLeafTree(),
    });

    const located = await index.seekFloorWithEntries({ key: 25, rootReference: "root" });
    expect(located.floor).toEqual({ key: 20, value: "twenty" });
    const entries: Entry[] = [];
    for await (const entry of located.entries) entries.push(entry);
    expect(entries).toEqual([
      { key: 20, value: "twenty" },
      { key: 30, value: "thirty" },
      { key: 50, value: "fifty" },
    ]);
    expect(observations.map(observation => [observation.operation, observation.structural.pageReads])).toEqual([
      ["seek_floor", 3],
      ["entries_from_floor", 0],
    ]);
  });

  it("continues bounded forward batches without rereading the located path", async () => {
    const observations: ImmutableBTreeDiagnosticsObservation[] = [];
    const index = reader({
      operationDiagnostics: {
        recordIndexOperation: observation => observations.push(observation),
      },
      pages: twoLeafTree(),
    });
    const cursor = index.createForwardCursor({ rootReference: "root" });

    await expect(cursor.nextBounded({ maximumEntries: 1 })).resolves.toEqual({
      entries: [{ key: 10, value: "ten" }],
      truncated: true,
    });
    await expect(cursor.nextBounded({ maximumEntries: 1 })).resolves.toEqual({
      entries: [{ key: 20, value: "twenty" }],
      truncated: true,
    });
    await expect(cursor.nextBounded({ maximumEntries: 1 })).resolves.toEqual({
      entries: [{ key: 30, value: "thirty" }],
      truncated: true,
    });
    await expect(cursor.nextBounded({ maximumEntries: 1 })).resolves.toEqual({
      entries: [{ key: 50, value: "fifty" }],
      truncated: false,
    });

    expect(observations.map(observation => [observation.operation, observation.structural.pageReads])).toEqual([
      ["entries", 2],
      ["entries", 1],
      ["entries", 0],
      ["entries", 0],
    ]);
  });

  it("keeps sibling-order validation across bounded forward cursor batches", async () => {
    const pages = new Map(twoLeafTree());
    pages.set("right", {
      entries: [
        { key: 15, value: "overlap" },
        { key: 50, value: "fifty" },
      ],
      level: 0,
      type: "leaf",
    });
    const cursor = reader({ pages }).createForwardCursor({ rootReference: "root" });

    await expect(cursor.nextBounded({ maximumEntries: 2 })).resolves.toEqual({
      entries: [
        { key: 10, value: "ten" },
        { key: 20, value: "twenty" },
      ],
      truncated: true,
    });
    await expect(cursor.nextBounded({ maximumEntries: 1 }))
      .rejects.toThrow("overlapping sibling keys");
  });

  it("does not advance a bounded forward cursor when maximumEntries is zero", async () => {
    const index = reader({ pages: twoLeafTree() });
    const cursor = index.createForwardCursor({ rootReference: "root" });

    await expect(cursor.nextBounded({ maximumEntries: 0 })).resolves.toEqual({ entries: [], truncated: true });
    await expect(cursor.nextBounded({ maximumEntries: 1 })).resolves.toEqual({
      entries: [{ key: 10, value: "ten" }],
      truncated: true,
    });
  });

  it("validates levels, exact upper bounds, disjoint ranges, and duplicate page references", async () => {
    const valid = reader({ pages: twoLeafTree() });
    await expect(valid.validateStructure({ rootReference: "root" })).resolves.toEqual({
      depth: 2,
      entryCount: 4,
      pageCount: 3,
    });

    const wrongBound = new Map(twoLeafTree());
    wrongBound.set("root", {
      children: [
        { childPageReference: "left", upperBound: 19 },
        { childPageReference: "right", upperBound: 50 },
      ],
      level: 1,
      type: "branch",
    });
    await expect(reader({ pages: wrongBound }).validateStructure({ rootReference: "root" })).rejects.toThrow("upper bound");

    const reusedChild = new Map(twoLeafTree());
    reusedChild.set("root", {
      children: [
        { childPageReference: "left", upperBound: 20 },
        { childPageReference: "left", upperBound: 50 },
      ],
      level: 1,
      type: "branch",
    });
    await expect(reader({ pages: reusedChild }).validateStructure({ rootReference: "root" })).rejects.toThrow("duplicate page reference");
  });

  it("reports bounded structural reads for lookup and partially consumed iteration", async () => {
    const observations: ImmutableBTreeDiagnosticsObservation[] = [];
    const index = reader({
      operationDiagnostics: {
        recordIndexOperation: observation => observations.push(observation),
      },
      pages: twoLeafTree(),
    });

    await expect(index.get({ key: 20, rootReference: "root" })).resolves.toEqual({ key: 20, value: "twenty" });
    for await (const _entry of index.entriesFromFloor({ key: 25, rootReference: "root" })) break;

    expect(observations).toHaveLength(2);
    expect(observations.map(observation => observation.operation)).toEqual(["get", "entries_from_floor"]);
    expect(observations[0]?.structural).toEqual({
      inputMutations: 0,
      maximumPageLevel: 1,
      pageReads: 2,
      pageWrites: 0,
      rootCollapses: 0,
      splitOperations: 0,
      splitOutputPages: 0,
      unchangedPageReuses: 0,
    });
    expect(observations[1]?.structural).toEqual({
      inputMutations: 0,
      maximumPageLevel: 1,
      pageReads: 3,
      pageWrites: 0,
      rootCollapses: 0,
      splitOperations: 0,
      splitOutputPages: 0,
      unchangedPageReuses: 0,
    });
  });
});
