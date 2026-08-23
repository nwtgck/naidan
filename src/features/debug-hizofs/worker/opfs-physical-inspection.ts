import { createAuthenticatedHizoFSInspectionPort } from "@/00-storage/service/hizofs/authenticated-store/inspection-port";
import type { AuthenticatedHizoFSPhysicalBytes } from "@/00-storage/service/hizofs/authenticated-store/physical-bytes";
import { OpfsWritableBackend } from "@/00-storage/service/hizofs/physical-store/opfs/opfs-writable-backend";
import {
  createHizoFSPhysicalInspectionDriver,
  createHizoFSPhysicalInspectionWorker,
  type HizoFSPhysicalInspectionWorker,
} from "./physical-inspection";

const MAXIMUM_PHYSICAL_PATH_COMPONENTS = 128;
const MAXIMUM_PHYSICAL_PATH_COMPONENT_UTF8_BYTES = 255;
const textEncoder = new TextEncoder();

function containsUnpairedSurrogate({ value }: { value: string }): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const current = value.charCodeAt(index);
    if (current >= 0xD800 && current <= 0xDBFF) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xDC00 && next <= 0xDFFF)) return true;
      index += 1;
      continue;
    }
    if (current >= 0xDC00 && current <= 0xDFFF) return true;
  }
  return false;
}

function validatePhysicalPathComponent({ component }: { component: string }): void {
  if (
    component.length === 0
    || component === "."
    || component === ".."
    || component.includes("/")
    || component.includes("\u0000")
    || containsUnpairedSurrogate({ value: component })
  ) {
    throw new Error(`invalid OPFS physical path component: ${JSON.stringify(component)}`);
  }
  if (textEncoder.encode(component).byteLength > MAXIMUM_PHYSICAL_PATH_COMPONENT_UTF8_BYTES) {
    throw new Error("OPFS physical path component exceeds the 255-byte bound");
  }
}

function capturePhysicalPath({ physicalPath }: {
  physicalPath: readonly string[];
}): readonly string[] {
  if (physicalPath.length === 0 || physicalPath.length > MAXIMUM_PHYSICAL_PATH_COMPONENTS) {
    throw new Error("OPFS physical path component count is outside the Inspector bound");
  }
  const captured = [...physicalPath];
  for (const component of captured) validatePhysicalPathComponent({ component });
  return captured;
}

async function openPhysicalDirectory({ physicalPath, root }: {
  physicalPath: readonly string[];
  root: FileSystemDirectoryHandle;
}): Promise<FileSystemDirectoryHandle> {
  let current = root;
  for (const component of physicalPath) current = await current.getDirectoryHandle(component);
  return current;
}

export async function createHizoFSPhysicalInspectionWorkerForOpfsPath({
  nativeOpfsRoot,
  physicalPath,
}: {
  nativeOpfsRoot: FileSystemDirectoryHandle | undefined;
  physicalPath: readonly string[];
}): Promise<HizoFSPhysicalInspectionWorker> {
  const capturedPhysicalPath = capturePhysicalPath({ physicalPath });
  const opfsRoot = nativeOpfsRoot ?? await navigator.storage.getDirectory();
  const containerRoot = await openPhysicalDirectory({ physicalPath: capturedPhysicalPath, root: opfsRoot });
  return createHizoFSPhysicalInspectionWorkerForDirectory({ containerRoot });
}

/**
 * Opens an independently selected HizoFS container as a read-only inspection
 * source. The directory handle remains source-owned and the returned surface
 * exposes only passphrase-bound authenticated inspection operations, never a
 * physical writer, Root Key, or decrypted filesystem handle.
 */
export function createHizoFSPhysicalInspectionWorkerForDirectory({ containerRoot }: {
  containerRoot: FileSystemDirectoryHandle;
}): HizoFSPhysicalInspectionWorker {
  const backend = new OpfsWritableBackend<AuthenticatedHizoFSPhysicalBytes>({ root: containerRoot });
  const physical = createAuthenticatedHizoFSInspectionPort({ backend });
  return createHizoFSPhysicalInspectionWorker({
    driver: createHizoFSPhysicalInspectionDriver({ physical }),
  });
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
  MAXIMUM_PHYSICAL_PATH_COMPONENTS,
};
