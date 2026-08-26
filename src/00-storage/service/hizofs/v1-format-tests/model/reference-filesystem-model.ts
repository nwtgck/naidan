import { exactObject } from "@/utils/exact-object";
import { compareObservableNamesByUtf8 } from "./observable-state-order";
import type {
  HizoFSV1FormatScenario,
  HizoFSV1FormatScenarioOperation,
} from "@/00-storage/service/hizofs/v1-format-tests/scenarios/scenario-types";

export type HizoFSV1ObservableEntry =
  | Readonly<{
      kind: "directory";
      path: string;
    }>
  | Readonly<{
      bytesHex: string;
      kind: "file";
      path: string;
      size: number;
    }>
  | Readonly<{
      kind: "symlink";
      path: string;
      target: string;
    }>;

export type HizoFSV1ObservableState = Readonly<{
  entries: readonly HizoFSV1ObservableEntry[];
}>;

type ModelDirectory = Readonly<{
  children: Map<string, ModelNode>;
  kind: "directory";
}>;

type ModelFile = Readonly<{
  bytes: Uint8Array;
  kind: "file";
}>;

type ModelSymlink = Readonly<{
  kind: "symlink";
  target: string;
}>;

type ModelNode = ModelDirectory | ModelFile | ModelSymlink;

function pathLabel({ path }: { path: readonly string[] }): string {
  return `/${path.join("/")}`;
}

function requireName({ path }: { path: readonly string[] }): string {
  const name = path.at(-1);
  if (name === undefined) throw new TypeError("scenario path must not be empty");
  return name;
}

function requireDirectory({ root, path }: { root: ModelDirectory; path: readonly string[] }): ModelDirectory {
  let current = root;
  for (const name of path) {
    const node = current.children.get(name);
    if (node === undefined) throw new Error(`reference model directory does not exist: ${pathLabel({ path })}`);
    switch (node.kind) {
    case "directory": current = node; break;
    case "file": throw new Error(`reference model path is a file: ${pathLabel({ path })}`);
    case "symlink": throw new Error(`reference model path is a symlink: ${pathLabel({ path })}`);
    default: return node satisfies never;
    }
  }
  return current;
}

function parentDirectory({ root, path }: { root: ModelDirectory; path: readonly string[] }): ModelDirectory {
  return requireDirectory({ root, path: path.slice(0, -1) });
}

function requireFile({ root, path }: { root: ModelDirectory; path: readonly string[] }): ModelFile {
  const parent = parentDirectory({ root, path });
  const node = parent.children.get(requireName({ path }));
  if (node === undefined) throw new Error(`reference model file does not exist: ${pathLabel({ path })}`);
  switch (node.kind) {
  case "file": return node;
  case "directory": throw new Error(`reference model path is a directory: ${pathLabel({ path })}`);
  case "symlink": throw new Error(`reference model path is a symlink: ${pathLabel({ path })}`);
  default: return node satisfies never;
  }
}

function resizedBytes({ bytes, size }: { bytes: Uint8Array; size: number }): Uint8Array {
  if (!Number.isSafeInteger(size) || size < 0) throw new TypeError(`invalid scenario file size: ${size}`);
  const next = new Uint8Array(size);
  next.set(bytes.subarray(0, Math.min(bytes.byteLength, size)));
  return next;
}

function bytesAfterWrite({ bytes, data, offset }: { bytes: Uint8Array; data: Uint8Array; offset: number }): Uint8Array {
  if (!Number.isSafeInteger(offset) || offset < 0) throw new TypeError(`invalid scenario write offset: ${offset}`);
  const requiredSize = offset + data.byteLength;
  if (!Number.isSafeInteger(requiredSize)) throw new TypeError("scenario write exceeds safe observable file size");
  const next = resizedBytes({ bytes, size: Math.max(bytes.byteLength, requiredSize) });
  next.set(data, offset);
  return next;
}

function applyOperation({ operation, root }: {
  operation: HizoFSV1FormatScenarioOperation;
  root: ModelDirectory;
}): void {
  switch (operation.type) {
  case "mkdir": {
    const { path, type: _type, ...unhandled } = operation;
    unhandled satisfies Record<PropertyKey, never>;
    const parent = parentDirectory({ root, path });
    const name = requireName({ path });
    const existing = parent.children.get(name);
    if (existing === undefined) {
      parent.children.set(name, { children: new Map(), kind: "directory" });
      return;
    }
    switch (existing.kind) {
    case "directory": return;
    case "file": throw new Error(`cannot mkdir over file: ${pathLabel({ path })}`);
    case "symlink": throw new Error(`cannot mkdir over symlink: ${pathLabel({ path })}`);
    default: return existing satisfies never;
    }
  }
  case "create_file": {
    const { path, type: _type, ...unhandled } = operation;
    unhandled satisfies Record<PropertyKey, never>;
    const parent = parentDirectory({ root, path });
    const name = requireName({ path });
    const existing = parent.children.get(name);
    if (existing === undefined) {
      parent.children.set(name, { bytes: new Uint8Array(), kind: "file" });
      return;
    }
    switch (existing.kind) {
    case "file": return;
    case "directory": throw new Error(`cannot create file over directory: ${pathLabel({ path })}`);
    case "symlink": throw new Error(`cannot create file over symlink: ${pathLabel({ path })}`);
    default: return existing satisfies never;
    }
  }
  case "write_file": {
    const { bytes, path, type: _type, ...unhandled } = operation;
    unhandled satisfies Record<PropertyKey, never>;
    const parent = parentDirectory({ root, path });
    const name = requireName({ path });
    const existing = parent.children.get(name);
    if (existing !== undefined) {
      switch (existing.kind) {
      case "file": break;
      case "directory": throw new Error(`cannot write file over directory: ${pathLabel({ path })}`);
      case "symlink": throw new Error(`cannot write file over symlink: ${pathLabel({ path })}`);
      default: existing satisfies never;
      }
    }
    parent.children.set(name, { bytes: Uint8Array.from(bytes), kind: "file" });
    return;
  }
  case "create_symlink": {
    const { path, target, type: _type, ...unhandled } = operation;
    unhandled satisfies Record<PropertyKey, never>;
    const parent = parentDirectory({ root, path });
    const name = requireName({ path });
    if (parent.children.has(name)) throw new Error(`cannot create symlink over existing entry: ${pathLabel({ path })}`);
    parent.children.set(name, { kind: "symlink", target });
    return;
  }
  case "write_file_at": {
    const { bytes, offset, path, type: _type, ...unhandled } = operation;
    unhandled satisfies Record<PropertyKey, never>;
    const file = requireFile({ root, path });
    parentDirectory({ root, path }).children.set(requireName({ path }), {
      bytes: bytesAfterWrite({ bytes: file.bytes, data: bytes, offset }),
      kind: "file",
    });
    return;
  }
  case "truncate_file": {
    const { path, size, type: _type, ...unhandled } = operation;
    unhandled satisfies Record<PropertyKey, never>;
    const file = requireFile({ root, path });
    parentDirectory({ root, path }).children.set(requireName({ path }), {
      bytes: resizedBytes({ bytes: file.bytes, size }),
      kind: "file",
    });
    return;
  }
  case "clone_file": {
    const { from, replace, to, type: _type, ...unhandled } = operation;
    unhandled satisfies Record<PropertyKey, never>;
    const source = requireFile({ root, path: from });
    const destinationParent = parentDirectory({ root, path: to });
    const destinationName = requireName({ path: to });
    if (!replace && destinationParent.children.has(destinationName)) {
      throw new Error(`cannot clone over existing entry: ${pathLabel({ path: to })}`);
    }
    destinationParent.children.set(destinationName, { bytes: Uint8Array.from(source.bytes), kind: "file" });
    return;
  }
  case "move_entry": {
    const { from, replace, to, type: _type, ...unhandled } = operation;
    unhandled satisfies Record<PropertyKey, never>;
    const sourceParent = parentDirectory({ root, path: from });
    const sourceName = requireName({ path: from });
    const node = sourceParent.children.get(sourceName);
    if (node === undefined) throw new Error(`cannot move missing entry: ${pathLabel({ path: from })}`);
    const destinationParent = parentDirectory({ root, path: to });
    const destinationName = requireName({ path: to });
    if (!replace && destinationParent.children.has(destinationName)) {
      throw new Error(`cannot move over existing entry: ${pathLabel({ path: to })}`);
    }
    destinationParent.children.set(destinationName, node);
    sourceParent.children.delete(sourceName);
    return;
  }
  case "remove_entry": {
    const { path, recursive, type: _type, ...unhandled } = operation;
    unhandled satisfies Record<PropertyKey, never>;
    const parent = parentDirectory({ root, path });
    const name = requireName({ path });
    const node = parent.children.get(name);
    if (node === undefined) throw new Error(`cannot remove missing entry: ${pathLabel({ path })}`);
    if (node.kind === "directory" && node.children.size > 0 && !recursive) {
      throw new Error(`cannot remove non-empty directory non-recursively: ${pathLabel({ path })}`);
    }
    parent.children.delete(name);
    return;
  }
  default: return operation satisfies never;
  }
}

function bytesHex({ bytes }: { bytes: Uint8Array }): string {
  return Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("");
}

function collectEntries({ directory, path, output }: {
  directory: ModelDirectory;
  output: HizoFSV1ObservableEntry[];
  path: readonly string[];
}): void {
  const names = [...directory.children.keys()].sort((left, right) => compareObservableNamesByUtf8({ left, right }));
  for (const name of names) {
    const node = directory.children.get(name);
    if (node === undefined) throw new TypeError(`reference model entry disappeared: ${name}`);
    const childPath = [...path, name];
    switch (node.kind) {
    case "directory":
      output.push(exactObject<HizoFSV1ObservableEntry>()({ kind: "directory", path: pathLabel({ path: childPath }) }));
      collectEntries({ directory: node, output, path: childPath });
      break;
    case "file":
      output.push(exactObject<HizoFSV1ObservableEntry>()({
        bytesHex: bytesHex({ bytes: node.bytes }),
        kind: "file",
        path: pathLabel({ path: childPath }),
        size: node.bytes.byteLength,
      }));
      break;
    case "symlink":
      output.push(exactObject<HizoFSV1ObservableEntry>()({
        kind: "symlink",
        path: pathLabel({ path: childPath }),
        target: node.target,
      }));
      break;
    default: return node satisfies never;
    }
  }
}

export function expectedObservableState({ scenario }: {
  scenario: HizoFSV1FormatScenario;
}): HizoFSV1ObservableState {
  const root: ModelDirectory = { children: new Map(), kind: "directory" };
  for (const operation of scenario.operations) applyOperation({ operation, root });
  const entries: HizoFSV1ObservableEntry[] = [];
  collectEntries({ directory: root, output: entries, path: [] });
  return exactObject<HizoFSV1ObservableState>()({ entries: Object.freeze(entries) });
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
