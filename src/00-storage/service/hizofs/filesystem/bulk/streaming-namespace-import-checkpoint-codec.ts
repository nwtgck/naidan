import {
  HIZOFS_V1_FORMAT_CONSTANTS,
  compareUnsignedBytes,
  createFileOffset,
  createInodeNumber,
  createInodeRevision,
  createTimestampMilliseconds,
  decodeBase64UrlUnpadded,
  decodeFilenameComponent,
  decodeRequiredHomeRecordReference,
  decodeRestrictedCanonicalJson,
  encodeBase64UrlUnpadded,
  encodeCanonicalAsciiString,
  encodeFilenameComponent,
  encodeHomeRecordReference,
  type DirectoryLeafEntry,
  type HomeRecordReference,
  type InodeTimestamps,
} from "@/00-storage/service/hizofs/00-format";
import type {
  SealedStreamingNamespaceImport,
  StreamingNamespaceDirectoryCheckpoint,
  StreamingNamespaceFileCheckpoint,
  StreamingNamespaceImportCheckpoint,
} from "@/00-storage/service/hizofs/filesystem/bulk/streaming-namespace-import";
import type { StreamingNamespaceImportJournalCandidate } from "@/00-storage/service/hizofs/filesystem/bulk/streaming-namespace-import-journal";

export const STREAMING_NAMESPACE_IMPORT_CHECKPOINT_CODEC = Object.freeze({
  format: "hizofs-streaming-namespace-import",
  formatVersion: 1,
  limits: Object.freeze({
    bytes: 6 * 1024 * 1024,
    directoryFrames: 65_536,
    inlineDirectoryEntries: 65_536,
    jsonDepth: 32,
    pathComponents: 1_024,
  }),
} as const);

const UINT64_MAXIMUM = (1n << 64n) - 1n;
type JsonObject = Record<string, unknown>;

function strictObject({ fields, label, value }: {
  fields: readonly string[];
  label: string;
  value: unknown;
}): JsonObject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  const object = value as JsonObject;
  const keys = Object.keys(object);
  if (keys.length !== fields.length || keys.some((key, index) => key !== fields[index])) {
    throw new TypeError(`${label} fields are unknown, missing, or out of canonical order`);
  }
  return object;
}

function stringValue({ label, value }: { label: string; value: unknown }): string {
  if (typeof value !== "string") throw new TypeError(`${label} must be a string`);
  return value;
}

function encodeUnsignedDecimal({ label, value }: { label: string; value: bigint }): string {
  if (value < 0n || value > UINT64_MAXIMUM) throw new RangeError(`${label} is outside UInt64`);
  return encodeCanonicalAsciiString({ value: value.toString() });
}

function parseUnsignedDecimal({ label, value }: { label: string; value: unknown }): bigint {
  const text = stringValue({ label, value });
  if (!/^(0|[1-9][0-9]*)$/u.test(text)) throw new TypeError(`${label} must be canonical unsigned decimal`);
  const parsed = BigInt(text);
  if (parsed > UINT64_MAXIMUM) throw new RangeError(`${label} exceeds UInt64`);
  return parsed;
}

function encodeTimestamp({ value }: { value: bigint | null }): string {
  return encodeCanonicalAsciiString({ value: value === null ? "" : value.toString() });
}

function parseTimestamp({ label, value }: { label: string; value: unknown }): ReturnType<typeof createTimestampMilliseconds> | null {
  const text = stringValue({ label, value });
  if (text === "") return null;
  if (!/^(0|-?[1-9][0-9]*)$/u.test(text)) throw new TypeError(`${label} must be canonical signed decimal or absent`);
  return createTimestampMilliseconds({ value: BigInt(text) });
}

function encodeTimestamps({ timestamps }: { timestamps: InodeTimestamps }): string {
  const { createdAt, modifiedAt, ...unhandled } = timestamps;
  unhandled satisfies Record<PropertyKey, never>;
  return `{"createdAt":${encodeTimestamp({ value: createdAt })},"modifiedAt":${encodeTimestamp({ value: modifiedAt })}}`;
}

function parseTimestamps({ value }: { value: unknown }): InodeTimestamps {
  const object = strictObject({ fields: ["createdAt", "modifiedAt"], label: "streaming import timestamps", value });
  return {
    createdAt: parseTimestamp({ label: "created timestamp", value: object.createdAt }),
    modifiedAt: parseTimestamp({ label: "modified timestamp", value: object.modifiedAt }),
  };
}

function encodeName({ name }: { name: string }): string {
  return encodeCanonicalAsciiString({ value: encodeBase64UrlUnpadded({ bytes: encodeFilenameComponent({ value: name }) }) });
}

function parseName({ label, value }: { label: string; value: unknown }): string {
  return decodeFilenameComponent({
    bytes: decodeBase64UrlUnpadded({
      maximumDecodedBytes: HIZOFS_V1_FORMAT_CONSTANTS.limits.filenameUtf8Bytes,
      value: stringValue({ label, value }),
    }),
  });
}

function encodePath({ path }: { path: readonly string[] }): string {
  if (path.length > STREAMING_NAMESPACE_IMPORT_CHECKPOINT_CODEC.limits.pathComponents) {
    throw new RangeError("streaming import path exceeds the component bound");
  }
  return `[${path.map((name) => encodeName({ name })).join(",")}]`;
}

function parsePath({ label, value }: { label: string; value: unknown }): readonly string[] {
  if (!Array.isArray(value)) throw new TypeError(`${label} must be an array`);
  if (value.length > STREAMING_NAMESPACE_IMPORT_CHECKPOINT_CODEC.limits.pathComponents) {
    throw new RangeError(`${label} exceeds the component bound`);
  }
  return value.map((component, index) => parseName({ label: `${label}[${index}]`, value: component }));
}

function encodeReference({ reference }: { reference: HomeRecordReference }): string {
  return encodeCanonicalAsciiString({ value: encodeBase64UrlUnpadded({ bytes: encodeHomeRecordReference({ reference }) }) });
}

function parseReference({ expectedRecordKind, label, value }: {
  expectedRecordKind: number;
  label: string;
  value: unknown;
}): HomeRecordReference {
  const reference = decodeRequiredHomeRecordReference({
    bytes: decodeBase64UrlUnpadded({
      maximumDecodedBytes: HIZOFS_V1_FORMAT_CONSTANTS.fixedSizes.recordReference,
      value: stringValue({ label, value }),
    }),
  });
  if (reference.recordKind !== expectedRecordKind) throw new TypeError(`${label} has the wrong record kind`);
  return reference;
}

function encodeOptionalReference({ reference }: { reference: HomeRecordReference | undefined }): string {
  return reference === undefined
    ? encodeCanonicalAsciiString({ value: "" })
    : encodeReference({ reference });
}

function parseOptionalReference({ expectedRecordKind, label, value }: {
  expectedRecordKind: number;
  label: string;
  value: unknown;
}): HomeRecordReference | undefined {
  const text = stringValue({ label, value });
  return text === "" ? undefined : parseReference({ expectedRecordKind, label, value: text });
}

function encodeDirectoryEntry({ entry }: { entry: DirectoryLeafEntry }): string {
  switch (entry.targetType) {
  case "inode": {
    const { inodeKind, inodeNumber, name, targetType, ...unhandled } = entry;
    unhandled satisfies Record<PropertyKey, never>;
    return `{"inodeKind":${encodeCanonicalAsciiString({ value: inodeKind })},"inodeNumber":${encodeUnsignedDecimal({ label: "directory entry Inode Number", value: inodeNumber })},"name":${encodeName({ name })},"targetType":${encodeCanonicalAsciiString({ value: targetType })}}`;
  }
  case "subvolume": throw new TypeError("streaming import checkpoint cannot contain a nested Subvolume entry");
  default: return entry satisfies never;
  }
}

function parseInodeKind({ value }: { value: unknown }): "directory" | "file" | "symlink" {
  switch (value) {
  case "directory":
  case "file":
  case "symlink": return value;
  default: throw new TypeError("streaming import directory entry inode kind is unsupported");
  }
}

function parseDirectoryEntry({ value }: { value: unknown }): Extract<DirectoryLeafEntry, { targetType: "inode" }> {
  const object = strictObject({
    fields: ["inodeKind", "inodeNumber", "name", "targetType"],
    label: "streaming import directory entry",
    value,
  });
  if (object.targetType !== "inode") throw new TypeError("streaming import checkpoint directory entry must target an inode");
  return {
    inodeKind: parseInodeKind({ value: object.inodeKind }),
    inodeNumber: createInodeNumber({ value: parseUnsignedDecimal({ label: "directory entry Inode Number", value: object.inodeNumber }) }),
    name: parseName({ label: "directory entry name", value: object.name }),
    targetType: "inode",
  };
}

function validateInlineEntries({ entries, previousName }: {
  entries: readonly Extract<DirectoryLeafEntry, { targetType: "inode" }>[];
  previousName: string | undefined;
}): void {
  let previousBytes: Uint8Array | undefined;
  for (const entry of entries) {
    const bytes = encodeFilenameComponent({ value: entry.name });
    if (previousBytes !== undefined && compareUnsignedBytes({ left: previousBytes, right: bytes }) >= 0) {
      throw new TypeError("streaming import inline directory entries are not canonically ordered");
    }
    previousBytes = bytes;
  }
  const lastName = entries.at(-1)?.name;
  if (lastName !== previousName) {
    throw new TypeError("streaming import directory previousName does not match its final inline entry");
  }
}

function encodeDirectoryContent({ content }: { content: StreamingNamespaceDirectoryCheckpoint["directory"]["content"] }): string {
  switch (content.type) {
  case "inline": {
    const { entries, type, ...unhandled } = content;
    unhandled satisfies Record<PropertyKey, never>;
    if (entries.length > STREAMING_NAMESPACE_IMPORT_CHECKPOINT_CODEC.limits.inlineDirectoryEntries) {
      throw new RangeError("streaming import inline directory exceeds the entry bound");
    }
    return `{"entries":[${entries.map((entry) => encodeDirectoryEntry({ entry })).join(",")}],"type":${encodeCanonicalAsciiString({ value: type })}}`;
  }
  case "tree": {
    const { directoryTreeRootHomeRef, type, ...unhandled } = content;
    unhandled satisfies Record<PropertyKey, never>;
    return `{"directoryTreeRootHomeRef":${encodeReference({ reference: directoryTreeRootHomeRef })},"type":${encodeCanonicalAsciiString({ value: type })}}`;
  }
  default: return content satisfies never;
  }
}

function parseDirectoryContent({ previousName, value }: {
  previousName: string | undefined;
  value: unknown;
}): StreamingNamespaceDirectoryCheckpoint["directory"]["content"] {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new TypeError("streaming import directory content must be an object");
  const type = (value as JsonObject).type;
  switch (type) {
  case "inline": {
    const object = strictObject({ fields: ["entries", "type"], label: "inline streaming import directory", value });
    if (!Array.isArray(object.entries)) throw new TypeError("inline streaming import directory entries must be an array");
    if (object.entries.length > STREAMING_NAMESPACE_IMPORT_CHECKPOINT_CODEC.limits.inlineDirectoryEntries) {
      throw new RangeError("streaming import inline directory exceeds the entry bound");
    }
    const entries = object.entries.map((entry) => parseDirectoryEntry({ value: entry }));
    validateInlineEntries({ entries, previousName });
    return { entries, type };
  }
  case "tree": {
    const object = strictObject({ fields: ["directoryTreeRootHomeRef", "type"], label: "tree streaming import directory", value });
    return {
      directoryTreeRootHomeRef: parseReference({
        expectedRecordKind: HIZOFS_V1_FORMAT_CONSTANTS.recordKinds.directory_page,
        label: "Directory Page root reference",
        value: object.directoryTreeRootHomeRef,
      }),
      type,
    };
  }
  default: throw new TypeError("streaming import directory content type is unsupported");
  }
}

function encodeDirectoryCheckpoint({ checkpoint }: { checkpoint: StreamingNamespaceDirectoryCheckpoint["directory"] }): string {
  const { content, inodeNumber, inodeRevision, previousName, timestamps, ...unhandled } = checkpoint;
  unhandled satisfies Record<PropertyKey, never>;
  switch (content.type) {
  case "inline":
    validateInlineEntries({
      entries: content.entries.flatMap((entry) => {
        switch (entry.targetType) {
        case "inode": return [entry];
        case "subvolume":
          throw new TypeError("streaming import checkpoint cannot contain a nested Subvolume entry");
        default: return entry satisfies never;
        }
      }),
      previousName,
    });
    break;
  case "tree": break;
  default: content satisfies never;
  }
  return `{"content":${encodeDirectoryContent({ content })},"inodeNumber":${encodeUnsignedDecimal({ label: "directory Inode Number", value: inodeNumber })},"inodeRevision":${encodeUnsignedDecimal({ label: "directory Inode Revision", value: inodeRevision })},"previousName":${previousName === undefined ? encodeCanonicalAsciiString({ value: "" }) : encodeName({ name: previousName })},"timestamps":${encodeTimestamps({ timestamps })}}`;
}

function parseDirectoryCheckpoint({ value }: { value: unknown }): StreamingNamespaceDirectoryCheckpoint["directory"] {
  const object = strictObject({
    fields: ["content", "inodeNumber", "inodeRevision", "previousName", "timestamps"],
    label: "streaming import directory checkpoint",
    value,
  });
  const previousText = stringValue({ label: "streaming import previous directory name", value: object.previousName });
  const previousName = previousText === "" ? undefined : parseName({ label: "streaming import previous directory name", value: previousText });
  return {
    content: parseDirectoryContent({ previousName, value: object.content }),
    inodeNumber: createInodeNumber({ value: parseUnsignedDecimal({ label: "directory Inode Number", value: object.inodeNumber }) }),
    inodeRevision: createInodeRevision({ value: parseUnsignedDecimal({ label: "directory Inode Revision", value: object.inodeRevision }) }),
    previousName,
    timestamps: parseTimestamps({ value: object.timestamps }),
  };
}

function encodeDirectoryFrame({ frame }: { frame: StreamingNamespaceDirectoryCheckpoint }): string {
  const { directory, path, ...unhandled } = frame;
  unhandled satisfies Record<PropertyKey, never>;
  return `{"directory":${encodeDirectoryCheckpoint({ checkpoint: directory })},"path":${encodePath({ path })}}`;
}

function parseDirectoryFrame({ value }: { value: unknown }): StreamingNamespaceDirectoryCheckpoint {
  const object = strictObject({ fields: ["directory", "path"], label: "streaming import directory frame", value });
  return {
    directory: parseDirectoryCheckpoint({ value: object.directory }),
    path: parsePath({ label: "streaming import directory path", value: object.path }),
  };
}

function encodeFileCheckpoint({ checkpoint }: { checkpoint: StreamingNamespaceFileCheckpoint["file"] }): string {
  const { extentRoot, nextOffset, ...unhandled } = checkpoint;
  unhandled satisfies Record<PropertyKey, never>;
  return `{"extentRoot":${encodeOptionalReference({ reference: extentRoot })},"nextOffset":${encodeUnsignedDecimal({ label: "streaming file next offset", value: nextOffset })}}`;
}

function parseFileCheckpoint({ value }: { value: unknown }): StreamingNamespaceFileCheckpoint["file"] {
  const object = strictObject({ fields: ["extentRoot", "nextOffset"], label: "streaming file checkpoint", value });
  return {
    extentRoot: parseOptionalReference({
      expectedRecordKind: HIZOFS_V1_FORMAT_CONSTANTS.recordKinds.file_extent_page,
      label: "File Extent Page root reference",
      value: object.extentRoot,
    }),
    nextOffset: createFileOffset({ value: parseUnsignedDecimal({ label: "streaming file next offset", value: object.nextOffset }) }),
  };
}

function encodeActiveFile({ activeFile }: { activeFile: StreamingNamespaceFileCheckpoint | undefined }): string {
  if (activeFile === undefined) return "{}";
  const { file, inodeNumber, path, ...unhandled } = activeFile;
  unhandled satisfies Record<PropertyKey, never>;
  return `{"file":${encodeFileCheckpoint({ checkpoint: file })},"inodeNumber":${encodeUnsignedDecimal({ label: "active file Inode Number", value: inodeNumber })},"path":${encodePath({ path })}}`;
}

function parseActiveFile({ value }: { value: unknown }): StreamingNamespaceFileCheckpoint | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new TypeError("streaming import active file must be an object");
  if (Object.keys(value as JsonObject).length === 0) return undefined;
  const object = strictObject({ fields: ["file", "inodeNumber", "path"], label: "streaming import active file", value });
  return {
    file: parseFileCheckpoint({ value: object.file }),
    inodeNumber: createInodeNumber({ value: parseUnsignedDecimal({ label: "active file Inode Number", value: object.inodeNumber }) }),
    path: parsePath({ label: "streaming import active file path", value: object.path }),
  };
}

function validateCheckpointPaths({ checkpoint }: { checkpoint: StreamingNamespaceImportCheckpoint }): void {
  if (checkpoint.directories.length === 0 || checkpoint.directories[0]?.path.length !== 0) {
    throw new TypeError("streaming import checkpoint must begin with the root directory frame");
  }
  for (let index = 1; index < checkpoint.directories.length; index += 1) {
    const parent = checkpoint.directories[index - 1]?.path;
    const child = checkpoint.directories[index]?.path;
    if (parent === undefined || child === undefined
      || child.length !== parent.length + 1
      || !parent.every((component, componentIndex) => component === child[componentIndex])) {
      throw new TypeError("streaming import directory frames are not one depth-first path");
    }
  }
  const currentDirectory = checkpoint.directories.at(-1)?.path;
  const activeParent = checkpoint.activeFile?.path.slice(0, -1);
  if (activeParent !== undefined
    && (currentDirectory === undefined
      || activeParent.length !== currentDirectory.length
      || !activeParent.every((component, index) => component === currentDirectory[index]))) {
    throw new TypeError("streaming import active file is not owned by the current directory frame");
  }
}

function encodeCheckpoint({ checkpoint }: { checkpoint: StreamingNamespaceImportCheckpoint }): string {
  validateCheckpointPaths({ checkpoint });
  const { activeFile, directories, nextInodeNumber, rootDirectoryInodeNumber, rootInodeTableRootHomeRef, ...unhandled } = checkpoint;
  unhandled satisfies Record<PropertyKey, never>;
  if (directories.length > STREAMING_NAMESPACE_IMPORT_CHECKPOINT_CODEC.limits.directoryFrames) {
    throw new RangeError("streaming import checkpoint exceeds the directory frame bound");
  }
  return `{"activeFile":${encodeActiveFile({ activeFile })},"directories":[${directories.map((frame) => encodeDirectoryFrame({ frame })).join(",")}],"nextInodeNumber":${encodeUnsignedDecimal({ label: "next Inode Number", value: nextInodeNumber })},"rootDirectoryInodeNumber":${encodeUnsignedDecimal({ label: "root directory Inode Number", value: rootDirectoryInodeNumber })},"rootInodeTableRootHomeRef":${encodeReference({ reference: rootInodeTableRootHomeRef })}}`;
}

function parseCheckpoint({ value }: { value: unknown }): StreamingNamespaceImportCheckpoint {
  const object = strictObject({
    fields: ["activeFile", "directories", "nextInodeNumber", "rootDirectoryInodeNumber", "rootInodeTableRootHomeRef"],
    label: "streaming namespace import checkpoint",
    value,
  });
  if (!Array.isArray(object.directories)) throw new TypeError("streaming import directory frames must be an array");
  if (object.directories.length > STREAMING_NAMESPACE_IMPORT_CHECKPOINT_CODEC.limits.directoryFrames) {
    throw new RangeError("streaming import checkpoint exceeds the directory frame bound");
  }
  const checkpoint: StreamingNamespaceImportCheckpoint = {
    activeFile: parseActiveFile({ value: object.activeFile }),
    directories: object.directories.map((frame) => parseDirectoryFrame({ value: frame })),
    nextInodeNumber: createInodeNumber({ value: parseUnsignedDecimal({ label: "next Inode Number", value: object.nextInodeNumber }) }),
    rootDirectoryInodeNumber: createInodeNumber({ value: parseUnsignedDecimal({ label: "root directory Inode Number", value: object.rootDirectoryInodeNumber }) }),
    rootInodeTableRootHomeRef: parseReference({
      expectedRecordKind: HIZOFS_V1_FORMAT_CONSTANTS.recordKinds.inode_table_page,
      label: "root Inode Table Page reference",
      value: object.rootInodeTableRootHomeRef,
    }),
  };
  validateCheckpointPaths({ checkpoint });
  return checkpoint;
}

function encodeSealed({ sealed }: { sealed: SealedStreamingNamespaceImport }): string {
  const { nextInodeNumber, rootDirectoryInodeNumber, rootInodeTableRootHomeRef, ...unhandled } = sealed;
  unhandled satisfies Record<PropertyKey, never>;
  return `{"nextInodeNumber":${encodeUnsignedDecimal({ label: "next Inode Number", value: nextInodeNumber })},"rootDirectoryInodeNumber":${encodeUnsignedDecimal({ label: "root directory Inode Number", value: rootDirectoryInodeNumber })},"rootInodeTableRootHomeRef":${encodeReference({ reference: rootInodeTableRootHomeRef })}}`;
}

function parseSealed({ value }: { value: unknown }): SealedStreamingNamespaceImport {
  const object = strictObject({
    fields: ["nextInodeNumber", "rootDirectoryInodeNumber", "rootInodeTableRootHomeRef"],
    label: "sealed streaming namespace import",
    value,
  });
  return {
    nextInodeNumber: createInodeNumber({ value: parseUnsignedDecimal({ label: "next Inode Number", value: object.nextInodeNumber }) }),
    rootDirectoryInodeNumber: createInodeNumber({ value: parseUnsignedDecimal({ label: "root directory Inode Number", value: object.rootDirectoryInodeNumber }) }),
    rootInodeTableRootHomeRef: parseReference({
      expectedRecordKind: HIZOFS_V1_FORMAT_CONSTANTS.recordKinds.inode_table_page,
      label: "root Inode Table Page reference",
      value: object.rootInodeTableRootHomeRef,
    }),
  };
}

export function encodeStreamingNamespaceImportJournalCandidate({ candidate }: {
  candidate: StreamingNamespaceImportJournalCandidate;
}): Uint8Array {
  const json = (() => {
    switch (candidate.type) {
    case "active": {
      const { checkpoint, type, ...unhandled } = candidate;
      unhandled satisfies Record<PropertyKey, never>;
      return `{"format":${encodeCanonicalAsciiString({ value: STREAMING_NAMESPACE_IMPORT_CHECKPOINT_CODEC.format })},"formatVersion":${STREAMING_NAMESPACE_IMPORT_CHECKPOINT_CODEC.formatVersion},"state":${encodeCanonicalAsciiString({ value: type })},"checkpoint":${encodeCheckpoint({ checkpoint })}}\n`;
    }
    case "sealed": {
      const { sealed, type, ...unhandled } = candidate;
      unhandled satisfies Record<PropertyKey, never>;
      return `{"format":${encodeCanonicalAsciiString({ value: STREAMING_NAMESPACE_IMPORT_CHECKPOINT_CODEC.format })},"formatVersion":${STREAMING_NAMESPACE_IMPORT_CHECKPOINT_CODEC.formatVersion},"state":${encodeCanonicalAsciiString({ value: type })},"sealed":${encodeSealed({ sealed })}}\n`;
    }
    default: return candidate satisfies never;
    }
  })();
  const bytes = new TextEncoder().encode(json);
  if (bytes.byteLength > STREAMING_NAMESPACE_IMPORT_CHECKPOINT_CODEC.limits.bytes) {
    throw new RangeError("streaming namespace import checkpoint exceeds the byte bound");
  }
  return bytes;
}

export function decodeStreamingNamespaceImportJournalCandidate({ bytes }: {
  bytes: Uint8Array;
}): StreamingNamespaceImportJournalCandidate {
  const value = decodeRestrictedCanonicalJson({
    bytes,
    maximumBytes: STREAMING_NAMESPACE_IMPORT_CHECKPOINT_CODEC.limits.bytes,
    maximumDepth: STREAMING_NAMESPACE_IMPORT_CHECKPOINT_CODEC.limits.jsonDepth,
  });
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("streaming namespace import checkpoint must be an object");
  }
  const state = (value as JsonObject).state;
  const object = (() => {
    switch (state) {
    case "active": return strictObject({ fields: ["format", "formatVersion", "state", "checkpoint"], label: "active streaming namespace import checkpoint", value });
    case "sealed": return strictObject({ fields: ["format", "formatVersion", "state", "sealed"], label: "sealed streaming namespace import checkpoint", value });
    default: throw new TypeError("streaming namespace import checkpoint state is unsupported");
    }
  })();
  if (object.format !== STREAMING_NAMESPACE_IMPORT_CHECKPOINT_CODEC.format
    || object.formatVersion !== STREAMING_NAMESPACE_IMPORT_CHECKPOINT_CODEC.formatVersion) {
    throw new TypeError("streaming namespace import checkpoint format/version is unsupported");
  }
  const candidate: StreamingNamespaceImportJournalCandidate = (() => {
    switch (state) {
    case "active": return { checkpoint: parseCheckpoint({ value: object.checkpoint }), type: state };
    case "sealed": return { sealed: parseSealed({ value: object.sealed }), type: state };
    default: return state satisfies never;
    }
  })();
  const canonical = encodeStreamingNamespaceImportJournalCandidate({ candidate });
  if (canonical.byteLength !== bytes.byteLength || canonical.some((byte, index) => byte !== bytes[index])) {
    throw new TypeError("streaming namespace import checkpoint is not canonical JSON");
  }
  return candidate;
}

export const TEST_ONLY = {
  parseDirectoryEntry,
  validateCheckpointPaths,
};
