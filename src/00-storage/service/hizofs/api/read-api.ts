import type {
  ReadOnlyInodeStat,
  ReadOnlyNamespace,
} from "@/00-storage/service/hizofs/filesystem/read-only-namespace";

export type HizoFSReadApiNamespace = Pick<
  ReadOnlyNamespace,
  "readFile" | "readlink" | "stat"
>;

export interface HizoFSReadApiRuntimeSession {
  close(): Promise<void>;
  runReadOperation<T>({ operation }: {
    operation: () => Promise<T>;
  }): Promise<T>;
}

export type HizoFSPortableStat =
  | Readonly<{
    createdAt: bigint | undefined;
    kind: "directory";
    modifiedAt: bigint | undefined;
    size: 0n;
  }>
  | Readonly<{
    createdAt: bigint | undefined;
    kind: "file";
    modifiedAt: bigint | undefined;
    size: bigint;
  }>
  | Readonly<{
    createdAt: bigint | undefined;
    kind: "symlink";
    modifiedAt: bigint | undefined;
    size: bigint;
  }>;

export type HizoFSReadApiErrorCode =
  | "missing_file_size";

export class HizoFSReadApiError extends Error {
  readonly code: HizoFSReadApiErrorCode;

  constructor({ code, message }: { code: HizoFSReadApiErrorCode; message: string }) {
    super(message);
    this.name = "HizoFSReadApiError";
    this.code = code;
  }
}

function portableTimestamps({ stat }: { stat: ReadOnlyInodeStat }) {
  return {
    createdAt: stat.createdAt ?? undefined,
    modifiedAt: stat.modifiedAt ?? undefined,
  };
}

export type HizoFSReadApi = Readonly<{
  close: () => Promise<void>;
  readFile: ({ length, offset, pathComponents }: {
    length?: bigint;
    offset?: bigint;
    pathComponents: readonly string[];
  }) => Promise<Uint8Array>;
  readlink: ({ pathComponents }: { pathComponents: readonly string[] }) => Promise<string>;
  stat: ({ pathComponents }: { pathComponents: readonly string[] }) => Promise<HizoFSPortableStat>;
}>;

/**
 * Projects the portable read surface without exposing storage owners, secret
 * capabilities, or lossy number adapters. Every operation remains owned by the
 * runtime session so close linearization also applies to public callers.
 */
export function createHizoFSReadApi({ namespace, session }: {
  namespace: HizoFSReadApiNamespace;
  session: HizoFSReadApiRuntimeSession;
}): HizoFSReadApi {
  return {
    close: async () => await session.close(),
    readFile: async ({ length, offset, pathComponents }) => {
      const capturedPath = [...pathComponents];
      return await session.runReadOperation({ operation: async () => (
        await namespace.readFile({ length, offset, pathComponents: capturedPath })
      ).slice() });
    },
    readlink: async ({ pathComponents }) => {
      const capturedPath = [...pathComponents];
      return await session.runReadOperation({
        operation: async () => await namespace.readlink({ pathComponents: capturedPath }),
      });
    },
    stat: async ({ pathComponents }) => {
      const capturedPath = [...pathComponents];
      return await session.runReadOperation({ operation: async () => {
        const stat = await namespace.stat({ pathComponents: capturedPath });
        const timestamps = portableTimestamps({ stat });
        switch (stat.kind) {
        case "directory": return { ...timestamps, kind: "directory", size: 0n };
        case "file":
          if (stat.fileSize === undefined) {
            throw new HizoFSReadApiError({
              code: "missing_file_size",
              message: "filesystem file stat omitted its lossless logical size",
            });
          }
          return { ...timestamps, kind: "file", size: stat.fileSize };
        case "symlink": {
          const target = await namespace.readlink({ pathComponents: capturedPath });
          return {
            ...timestamps,
            kind: "symlink",
            size: BigInt(new TextEncoder().encode(target).byteLength),
          };
        }
        default: return stat.kind satisfies never;
        }
      } });
    },
  };
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
