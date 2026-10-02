export type BoundedNamespacePath = readonly string[];

export type BoundedNamespaceMetadata = Readonly<{
  createdAt: bigint | undefined;
  modifiedAt: bigint | undefined;
}>;

export type BoundedNamespaceEntry =
  | Readonly<{ kind: "directory"; metadata: BoundedNamespaceMetadata; name: string }>
  | Readonly<{ kind: "file"; metadata: BoundedNamespaceMetadata; name: string; size: bigint }>
  | Readonly<{ kind: "symlink"; metadata: BoundedNamespaceMetadata; name: string }>;

export interface BoundedNamespaceSourcePort {
  readRootMetadata(): Promise<BoundedNamespaceMetadata>;
  listDirectory({ afterName, maximumEntries, path }: {
    afterName: string | undefined;
    maximumEntries: number;
    path: BoundedNamespacePath;
  }): Promise<Readonly<{ entries: readonly BoundedNamespaceEntry[]; state: "complete" | "more" }>>;
  readFileChunk({ maximumBytes, offset, path }: {
    maximumBytes: number;
    offset: bigint;
    path: BoundedNamespacePath;
  }): Promise<Readonly<{ bytes: Uint8Array; state: "complete" | "more" }>>;
  readSymlink({ path }: { path: BoundedNamespacePath }): Promise<string>;
}

export interface BoundedNamespaceTargetPort {
  setRootMetadata({ metadata }: { metadata: BoundedNamespaceMetadata }): Promise<void>;
  /**
   * Seals the private namespace after the source traversal reaches its exact end.
   *
   * The caller may retry this call after a lost response, so target
   * implementations must resolve the already-sealed outcome idempotently and
   * must not publish routing authority from this gate.
   */
  completeNamespace(): Promise<void>;
  ensureDirectory({ metadata, path }: { metadata: BoundedNamespaceMetadata; path: BoundedNamespacePath }): Promise<void>;
  finalizeFile({ metadata, path, size }: {
    metadata: BoundedNamespaceMetadata;
    path: BoundedNamespacePath;
    size: bigint;
  }): Promise<void>;
  writeFileChunk({ bytes, offset, path }: {
    bytes: Uint8Array;
    offset: bigint;
    path: BoundedNamespacePath;
  }): Promise<void>;
  writeSymlink({ metadata, path, target }: {
    metadata: BoundedNamespaceMetadata;
    path: BoundedNamespacePath;
    target: string;
  }): Promise<void>;
}
