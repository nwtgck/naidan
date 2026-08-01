import { describe, expect, it } from "vitest";
import {
  ImmutableBTreeReader,
  type ImmutableBTreePage,
} from "@/00-storage/service/hizofs/indexes/immutable-btree-reader";

type Entry = Readonly<{ key: number; value: string }>;
type Page = ImmutableBTreePage<number, Entry, string>;

function reader({ pages }: { pages: ReadonlyMap<string, Page> }): ImmutableBTreeReader<number, Entry, string> {
  return new ImmutableBTreeReader({
    compareKeys: ({ left, right }) => left - right,
    getEntryKey: ({ entry }) => entry.key,
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
});
