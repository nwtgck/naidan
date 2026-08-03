export type InodeLeafLookupDiagnosticsObservation =
  | Readonly<{
      event: "branch_page_decode";
      pageBytes: number;
    }>
  | Readonly<{
      event: "index_build";
      indexBytes: number;
      indexedEntries: number;
      pageBytes: number;
    }>
  | Readonly<{
      entryBytes: number;
      event: "selective_entry_hit";
      pageBytes: number;
    }>
  | Readonly<{
      event: "selective_entry_miss";
      pageBytes: number;
    }>;

export type DecodedInodeIndexPageCacheDiagnosticsPort = Readonly<{
  recordDecodedInodeIndexPageCacheEvent: ({ event }: {
    event: "eviction" | "hit" | "miss";
  }) => void;
  recordInodeLeafLookup: ({ observation }: {
    observation: InodeLeafLookupDiagnosticsObservation;
  }) => void;
  setDecodedInodeIndexPageCacheUsage: ({ bytes, entries }: {
    bytes: number;
    entries: number;
  }) => void;
}>;

export const TEST_ONLY = {
};
