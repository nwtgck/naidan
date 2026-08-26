import { createHash } from "node:crypto";
import { authenticatedHizoFSPhysicalBytes, type AuthenticatedHizoFSPhysicalBytes } from "@/00-storage/service/hizofs/authenticated-store/physical-bytes";
import { InMemoryCrashDurabilityBackend } from "@/00-storage/service/hizofs/physical-store/testing/in-memory-crash-durability-backend";
import type { CanonicalContainerDirectory } from "@/00-storage/service/hizofs/physical-store/paths";
import {
  CANONICAL_CONTAINER_ROOT,
  canonicalContainerDirectory,
  canonicalContainerPath,
  parentContainerDirectory,
} from "@/00-storage/service/hizofs/physical-store/paths";
import { exactObject } from "@/utils/exact-object";
import { z } from "zod";

const frozenPortableContainerFileSchema = z.object({
  byteLength: z.number().int().nonnegative(),
  hex: z.string(),
  path: z.string(),
  sha256: z.string(),
}).strict();

const frozenPortableContainerFixtureSchema = z.object({
  fileSystemId: z.string(),
  files: z.array(frozenPortableContainerFileSchema).readonly(),
  passphrase: z.string(),
  schema: z.enum(["hizofs-v1-empty-container-fixture", "hizofs-v1-nonempty-container-fixture"]),
  schemaVersion: z.literal(1),
}).strict();

export type FrozenPortableContainerFixture = z.infer<typeof frozenPortableContainerFixtureSchema>;

function decodeHex({ hex }: { hex: string }): Uint8Array {
  if (hex.length % 2 !== 0 || !/^[0-9a-f]*$/u.test(hex)) throw new TypeError("portable fixture hex must be lowercase even-length hex");
  return Uint8Array.from({ length: hex.length / 2 }, (_, index) => Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16));
}

export function validateFrozenPortableContainerFixture({ fixture }: {
  fixture: unknown;
}): FrozenPortableContainerFixture {
  const parsed = frozenPortableContainerFixtureSchema.parse(fixture);
  const { fileSystemId, files, passphrase, schema, schemaVersion, ...unhandledFixture } = parsed;
  unhandledFixture satisfies Record<PropertyKey, never>;
  if (schemaVersion !== 1) throw new TypeError(`unsupported portable fixture schema version: ${schemaVersion}`);
  if (files.length === 0) throw new TypeError("portable fixture must contain persisted files");
  for (const file of files) {
    const { byteLength, hex, path, sha256, ...unhandledFile } = file;
    unhandledFile satisfies Record<PropertyKey, never>;
    const bytes = decodeHex({ hex });
    if (bytes.byteLength !== byteLength) throw new TypeError(`portable fixture byte length mismatch: ${path}`);
    const observedHash = createHash("sha256").update(bytes).digest("hex");
    if (observedHash !== sha256) throw new TypeError(`portable fixture SHA-256 mismatch: ${path}`);
  }
  return exactObject<FrozenPortableContainerFixture>()({ fileSystemId, files, passphrase, schema, schemaVersion });
}


export async function collectPortableContainerFiles({ backend, directory }: {
  backend: InMemoryCrashDurabilityBackend<AuthenticatedHizoFSPhysicalBytes>;
  directory: CanonicalContainerDirectory;
}): Promise<FrozenPortableContainerFixture["files"]> {
  const collected: Array<FrozenPortableContainerFixture["files"][number]> = [];
  const visit = async ({ current }: { current: CanonicalContainerDirectory }): Promise<void> => {
    const entries = await backend.list({ directory: current });
    for (const entry of entries) {
      const path = current === CANONICAL_CONTAINER_ROOT ? entry.name : `${current}/${entry.name}`;
      switch (entry.kind) {
      case "directory":
        await visit({ current: canonicalContainerDirectory({ value: path }) });
        break;
      case "file": {
        if (entry.byteLength > BigInt(Number.MAX_SAFE_INTEGER)) {
          throw new RangeError(`portable fixture file is too large: ${path}`);
        }
        const byteLength = Number(entry.byteLength);
        const bytes = await backend.readFileBounded({
          maximumByteLength: byteLength,
          path: canonicalContainerPath({ value: path }),
        });
        if (bytes === undefined) throw new Error(`portable fixture file disappeared: ${path}`);
        collected.push(exactObject<FrozenPortableContainerFixture["files"][number]>()({
          byteLength,
          hex: Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join(""),
          path,
          sha256: createHash("sha256").update(bytes).digest("hex"),
        }));
        break;
      }
      default: return entry satisfies never;
      }
    }
  };
  await visit({ current: directory });
  collected.sort((left, right) => left.path.localeCompare(right.path));
  return Object.freeze(collected);
}

export async function createFrozenPortableContainerFixture({ backend, fileSystemId, passphrase, schema }: {
  backend: InMemoryCrashDurabilityBackend<AuthenticatedHizoFSPhysicalBytes>;
  fileSystemId: string;
  passphrase: string;
  schema: FrozenPortableContainerFixture["schema"];
}): Promise<FrozenPortableContainerFixture> {
  const files = await collectPortableContainerFiles({ backend, directory: CANONICAL_CONTAINER_ROOT });
  return validateFrozenPortableContainerFixture({
    fixture: exactObject<FrozenPortableContainerFixture>()({
      fileSystemId,
      files,
      passphrase,
      schema,
      schemaVersion: 1,
    }),
  });
}


function parentDirectoryOfDirectory({ directory }: { directory: string }) {
  const separatorIndex = directory.lastIndexOf("/");
  return separatorIndex < 0
    ? CANONICAL_CONTAINER_ROOT
    : canonicalContainerDirectory({ value: directory.slice(0, separatorIndex) });
}

function parentDirectories({ path }: { path: string }): readonly string[] {
  const segments = path.split("/");
  const directories: string[] = [];
  for (let length = 1; length < segments.length; length += 1) directories.push(segments.slice(0, length).join("/"));
  return directories;
}

export async function restoreFrozenPortableContainerIntoBackend({ backend, fixture }: {
  backend: InMemoryCrashDurabilityBackend<AuthenticatedHizoFSPhysicalBytes>;
  fixture: FrozenPortableContainerFixture;
}): Promise<void> {
  const validated = validateFrozenPortableContainerFixture({ fixture });
  const directories = [...new Set(validated.files.flatMap(file => parentDirectories({ path: file.path })))].sort((left, right) => {
    const depth = left.split("/").length - right.split("/").length;
    return depth === 0 ? left.localeCompare(right) : depth;
  });
  for (const directory of directories) {
    const canonicalDirectory = canonicalContainerDirectory({ value: directory });
    const result = await backend.createDirectoryExclusive({ path: canonicalDirectory });
    if (result.parentEntrySyncRequired) await backend.syncDirectoryEntries({ parent: parentDirectoryOfDirectory({ directory }) });
  }
  for (const file of validated.files) {
    const path = canonicalContainerPath({ value: file.path });
    const handle = await backend.createFileExclusive({ path });
    try {
      await backend.writeAt({ bytes: authenticatedHizoFSPhysicalBytes({ bytes: decodeHex({ hex: file.hex }) }), file: handle, offset: 0n });
      await backend.syncFileData({ file: handle });
    } finally {
      await backend.closeFile({ file: handle });
    }
    await backend.syncDirectoryEntries({ parent: parentContainerDirectory({ path }) });
  }
  await backend.syncDirectoryEntries({ parent: CANONICAL_CONTAINER_ROOT });
}

export async function restoreFrozenPortableContainer({ fixture }: {
  fixture: FrozenPortableContainerFixture;
}): Promise<InMemoryCrashDurabilityBackend<AuthenticatedHizoFSPhysicalBytes>> {
  const backend = new InMemoryCrashDurabilityBackend<AuthenticatedHizoFSPhysicalBytes>({});
  await restoreFrozenPortableContainerIntoBackend({ backend, fixture });
  return backend;
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
