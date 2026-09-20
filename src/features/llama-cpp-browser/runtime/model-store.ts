import { LlamaCppBrowserError, modelSchema, type LocalModel, type Progress } from "@/features/llama-cpp-browser/types";
import { logDiagnostic } from "@/features/llama-cpp-browser/debug-log";

const directoryName = "llama-cpp-browser-models";
const lockName = "naidan-llama-cpp-browser-model-store";

function isMissing({ error }: { error: unknown }): boolean {
  return error instanceof DOMException && (error.name === "NotFoundError" || error.name === "TypeMismatchError");
}
function modelPath({ name }: { name: string }): { directory: string, file: string, marker: string, id: string } {
  // Model storage is a regular file tree, not the transactional naidan-storage
  // database. No metadata JSON, UUID registry or hashed directory is required.
  // Keep the original filename so a future external filesystem reader can use
  // an existing GGUF without copying it into an application-owned container.
  if (!/^.+\.gguf$/i.test(name) || (name.includes("/") || name.includes("\\") || Array.from(name).some(character => character.charCodeAt(0) < 32))
    || new TextEncoder().encode(name).byteLength > 245) {
    throw new LlamaCppBrowserError({ code: "invalid-gguf" });
  }
  const directory = `${name.slice(0, -5)}-GGUF`;
  return { directory, file: name, marker: `.${name}.complete`, id: `user/${directory}/${name}` };
}
async function userDirectory(): Promise<FileSystemDirectoryHandle> {
  if (!navigator.storage?.getDirectory) throw new LlamaCppBrowserError({ code: "unavailable" });
  const root = await navigator.storage.getDirectory();
  const models = await root.getDirectoryHandle(directoryName, { create: true });
  return models.getDirectoryHandle("user", { create: true });
}
async function validHeader({ file }: { file: File }): Promise<boolean> {
  if (!Number.isSafeInteger(file.size) || file.size < 24) return false;
  const bytes = new Uint8Array(await file.slice(0, 8).arrayBuffer());
  return bytes.length === 8 && bytes[0] === 71 && bytes[1] === 71 && bytes[2] === 85 && bytes[3] === 70
    && [2, 3].includes(new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(4, true));
}
function describe({ file }: { file: File }): LocalModel {
  const path = modelPath({ name: file.name });
  return modelSchema.parse({ id: path.id, name: path.directory, size: file.size, importedAt: file.lastModified });
}
export async function withModelStoreLock<T>({ operation }: { operation: () => Promise<T> }): Promise<T> {
  if (!navigator.locks) throw new LlamaCppBrowserError({ code: "unavailable" });
  return navigator.locks.request(lockName, operation);
}
export async function listStoredModels(): Promise<LocalModel[]> {
  const root = await userDirectory(); const result: LocalModel[] = [];
  for await (const [directory, folder] of root.entries()) {
    switch (folder.kind) {
    case "file": continue;
    case "directory": break;
    default: throw new Error(`Unexpected entry kind: ${((folder satisfies never) as { readonly kind: string }).kind}`);
    }
    for await (const [name, entry] of folder.entries()) {
      switch (entry.kind) {
      case "directory": continue;
      case "file": break;
      default: throw new Error(`Unexpected entry kind: ${((entry satisfies never) as { readonly kind: string }).kind}`);
      }
      let path: ReturnType<typeof modelPath>;
      try {
        path = modelPath({ name });
      } catch {
        continue;
      }
      if (path.directory !== directory) continue;
      try {
        await folder.getFileHandle(path.marker);
        const file = await entry.getFile();
        if (await validHeader({ file })) result.push(describe({ file }));
      } catch (error) {
        if (!isMissing({ error })) throw error;
      }
    }
  }
  // A read never repairs, migrates or deletes files. Incomplete imports remain
  // unlisted; only an explicit import retry or deletion may modify this tree.
  return result.sort((a, b) => a.name.localeCompare(b.name));
}
export async function importStoredModel({ file, onProgress }: { file: File, onProgress: ({ progress }: { progress: Progress }) => void }): Promise<LocalModel> {
  const path = modelPath({ name: file.name });
  if (!await validHeader({ file })) throw new LlamaCppBrowserError({ code: "invalid-gguf" });
  const root = await userDirectory();
  const folder = await root.getDirectoryHandle(path.directory, { create: true });
  // Only retry our exact incomplete file. Never overwrite a completed import or
  // recursively remove extra files placed here through another filesystem UI.
  for await (const [name, entry] of folder.entries()) {
    if (name !== path.file || entry.kind !== "file") throw new LlamaCppBrowserError({ code: "duplicate-model" });
  }
  let writer: FileSystemWritableFileStream | undefined;
  let published = false;
  const started = performance.now();
  logDiagnostic({ diagnostic: { event: "import-start", bytes: file.size } });
  try {
    const destination = await folder.getFileHandle(path.file, { create: true });
    writer = await destination.createWritable();
    const reader = file.stream().getReader(); let completed = 0; let lastProgress = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (completed + value.byteLength > file.size) throw new LlamaCppBrowserError({ code: "storage-error" });
        await writer.write(value); completed += value.byteLength;
        if (performance.now() - lastProgress > 150) {
          onProgress({ progress: { phase: "importing", completed, total: file.size } }); lastProgress = performance.now();
        }
      }
    } catch (error) {
      await reader.cancel().catch(() => {}); throw error;
    } finally {
      reader.releaseLock();
    }
    if (completed !== file.size) throw new LlamaCppBrowserError({ code: "storage-error" });
    await writer.close(); writer = undefined;
    const stored = await destination.getFile();
    if (stored.size !== file.size || !await validHeader({ file: stored })) throw new LlamaCppBrowserError({ code: "storage-error" });
    // Publication marker, not model metadata: create only after the GGUF writer
    // is closed and its stored size/header checked. It does not certify inference.
    await folder.getFileHandle(path.marker, { create: true });
    published = true;
    onProgress({ progress: { phase: "importing", completed, total: file.size } });
    logDiagnostic({ diagnostic: { event: "import-complete", bytes: completed, elapsedMs: performance.now() - started } });
    return describe({ file: stored });
  } catch (error) {
    await writer?.abort().catch(() => {});
    if (!published) {
      await folder.removeEntry(path.file).catch(() => {});
      await root.removeEntry(path.directory).catch(() => {});
    }
    throw error;
  }
}
export async function removeStoredModel({ id }: { id: string }): Promise<void> {
  const name = id.split("/")[2];
  if (name === undefined) throw new LlamaCppBrowserError({ code: "missing-model" });
  const path = modelPath({ name });
  if (id !== path.id) throw new LlamaCppBrowserError({ code: "missing-model" });
  const root = await userDirectory(); const folder = await root.getDirectoryHandle(path.directory);
  for (const name of [path.marker, path.file]) {
    try {
      await folder.removeEntry(name);
    } catch (error) {
      if (!isMissing({ error })) throw error;
    }
  }
  try {
    await root.removeEntry(path.directory);
  } catch (error) {
    if (!(error instanceof DOMException && error.name === "InvalidModificationError")) throw error;
  }
}
export async function storedModelHandle({ name }: { name: string }): Promise<FileSystemFileHandle> {
  // Saved chats may still select the original filename. New selections identify
  // the model directory; preserve the actual filename and publication marker.
  const directorySelected = name.endsWith("-GGUF");
  let path = modelPath({ name: directorySelected ? `${name.slice(0, -5)}.gguf` : name });
  try {
    const folder = await (await userDirectory()).getDirectoryHandle(path.directory);
    if (directorySelected) {
      let selected: ReturnType<typeof modelPath> | undefined;
      for await (const [filename, entry] of folder.entries()) {
        switch (entry.kind) {
        case "directory": continue;
        case "file": break;
        default: throw new Error(`Unexpected entry kind: ${((entry satisfies never) as { readonly kind: string }).kind}`);
        }
        let candidate: ReturnType<typeof modelPath>;
        try {
          candidate = modelPath({ name: filename });
        } catch {
          continue;
        }
        if (candidate.directory === name) {
          if (selected) throw new LlamaCppBrowserError({ code: "unsupported-input" });
          selected = candidate;
        }
      }
      if (!selected) throw new LlamaCppBrowserError({ code: "missing-model" });
      path = selected;
    }
    await folder.getFileHandle(path.marker);
    const handle = await folder.getFileHandle(path.file);
    if (!await validHeader({ file: await handle.getFile() })) throw new LlamaCppBrowserError({ code: "missing-model" });
    return handle;
  } catch (error) {
    if (isMissing({ error })) throw new LlamaCppBrowserError({ code: "missing-model" });
    throw error;
  }
}
export const TEST_ONLY = {
};
