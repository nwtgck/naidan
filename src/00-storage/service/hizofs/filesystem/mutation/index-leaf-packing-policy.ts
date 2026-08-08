export type HizoFSIndexLeafEntryLimits = Readonly<{
  directory: number;
  fileExtent: number;
  rootInodeTable: number;
}>;

/**
 * Runtime leaf-packing policy for valid immutable V1 index trees. These limits are
 * deliberately below the persisted 64 KiB hard bound so ordinary Copy-on-Write
 * mutations rewrite bounded leaf payloads instead of a growing monolithic root.
 * Branch pages remain high-fanout and are bounded by the existing byte limit;
 * no persisted page layout or reader-validity rule changes.
 */
export const DEFAULT_HIZOFS_INDEX_LEAF_ENTRY_LIMITS: HizoFSIndexLeafEntryLimits = Object.freeze({
  directory: 64,
  fileExtent: 64,
  rootInodeTable: 32,
});


export const TEST_ONLY = {
};
