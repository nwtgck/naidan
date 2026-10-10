import { SCALAR, UNKNOWN, type Value } from '../../analysis/values.ts';
import { isScalarValue, passiveData } from '../../analysis/value-guards.ts';
import type { OperationRule, OperationInput } from '../operation.ts';
import { filesystemCreationPossible } from './filesystem-options.ts';
import { passiveArguments } from './guards.ts';

/** Provenance comes from the analyzer/root operation, never the word "write". */
const FILE_SYSTEM_RECEIVERS = [
  { directory: 'opfs.directory', file: 'opfs.file', writer: 'opfs.writer', sync: 'opfs.sync', regions: ['opfs'] },
  { directory: 'hostfs.directory', file: 'hostfs.file', writer: 'hostfs.writer', sync: 'hostfs.sync', regions: ['hostfs'] },
  { directory: 'FileSystemDirectoryHandle', file: 'FileSystemFileHandle', writer: 'FileSystemWritableFileStream', sync: 'FileSystemSyncAccessHandle', regions: ['opfs', 'hostfs'] },
] as const;

function directoryArguments({ context, args, node }: OperationInput): void {
  if (args[0] !== undefined && !isScalarValue(args[0])) context.issue({ node, code: 'unsupported', message: 'Filesystem names require scalar conversion evidence.' });
  if (args[1] !== undefined && !passiveData({ value: args[1], seen: new Set() })) context.issue({ node, code: 'unsupported', message: 'Filesystem options require passive data evidence.' });
}

/**
 * Each handle family enumerates legal operation names. Unknown methods do not
 * inherit a blanket read/write. Effects and return provenance stay together.
 * Source: https://fs.spec.whatwg.org/
 */
export const FILE_SYSTEM_OPERATIONS: readonly OperationRule[] = FILE_SYSTEM_RECEIVERS.flatMap(family => {
  const { directory, file, writer, sync, regions, ...rest } = family;
  rest satisfies Record<PropertyKey, never>;
  const reads = regions.map(region => `${region}.read`);
  const writes = regions.map(region => `${region}.write`);
  return [
    ...(['getDirectoryHandle', 'getFileHandle'] as const).map(method => ({
      id: `${directory}.${method}`,
      definedIn: import.meta.url,
      access: 'call',
      targets: [`${directory}.${method}`],
      policy: {
        kind: 'conditional',
        possibleEffects: [...reads, ...writes],
        reason: 'Handle lookup reads storage; create:true or an unresolved create option also permits a write. Later option overwrites are respected.',
        select: ({ node, args }) => filesystemCreationPossible({ node, options: args[1] }) ? [...reads, ...writes] : reads,
      },
      evaluate: input => {
        directoryArguments(input);
        const name = (() => {
          switch (method) {
          case 'getFileHandle': return file;
          case 'getDirectoryHandle': return directory;
          default: { const exhaustive: never = method; throw new Error(String(exhaustive)); }
          }
        })();
        return { kind: 'promise', value: input.context.native({ name, receiver: undefined }) };
      },
    } satisfies OperationRule)),
    {
      id: `${directory}.remove-entry`,
      definedIn: import.meta.url,
      access: 'call',
      targets: [`${directory}.removeEntry`, `${directory}.remove`, `${directory}.move`],
      policy: { kind: 'tracked', effects: writes, reason: 'Removing or moving an entry mutates stored content, including directories.' },
      evaluate: input => {
        passiveArguments(input); return { kind: 'promise', value: SCALAR };
      },
    },
    {
      id: `${directory}.enumerate`,
      definedIn: import.meta.url,
      access: 'call',
      targets: ['entries', 'keys', 'values', 'resolve'].map(method => `${directory}.${method}`),
      policy: { kind: 'tracked', effects: reads, reason: 'Directory enumeration/resolution reads stored names. Iterator consumption needs a separate model.' },
      evaluate: input => {
        passiveArguments(input); return UNKNOWN;
      },
    },
    {
      id: `${file}.get-file`,
      definedIn: import.meta.url,
      access: 'call',
      targets: [`${file}.getFile`],
      policy: { kind: 'tracked', effects: reads, reason: 'Obtaining file data is a content read; an unknown handle provenance retains both storage candidates.' },
      evaluate: input => {
        passiveArguments(input); return { kind: 'promise', value: input.context.native({ name: 'File', receiver: undefined }) };
      },
    },
    {
      id: `${file}.create-writable`,
      definedIn: import.meta.url,
      access: 'call',
      targets: [`${file}.createWritable`],
      policy: { kind: 'tracked', effects: writes, reason: 'Acquiring a writable file stream permits file replacement. Preserve its storage provenance, unlike a memory stream.' },
      evaluate: input => {
        passiveArguments(input); return { kind: 'promise', value: input.context.native({ name: writer, receiver: undefined }) };
      },
    },
    {
      id: `${file}.create-sync-access`,
      definedIn: import.meta.url,
      access: 'call',
      targets: [`${file}.createSyncAccessHandle`],
      policy: { kind: 'tracked', effects: writes, reason: 'Acquiring synchronous storage access has a write-capable upper bound and preserves provenance.' },
      evaluate: input => {
        passiveArguments(input); return { kind: 'promise', value: input.context.native({ name: sync, receiver: undefined }) };
      },
    },
    {
      id: `${file}.mutate`,
      definedIn: import.meta.url,
      access: 'call',
      targets: [`${file}.remove`, `${file}.move`],
      policy: { kind: 'tracked', effects: writes, reason: 'Removing or moving a file changes stored content.' },
      evaluate: input => {
        passiveArguments(input); return { kind: 'promise', value: SCALAR };
      },
    },
    {
      id: `${writer}.mutate`,
      definedIn: import.meta.url,
      access: 'call',
      targets: ['write', 'truncate', 'close', 'abort'].map(method => `${writer}.${method}`),
      policy: { kind: 'tracked', effects: writes, reason: 'Writing, truncating, committing or aborting a file writer remains a history-independent storage write/control effect.' },
      evaluate: input => {
        passiveArguments(input); return { kind: 'promise', value: SCALAR };
      },
    },
    {
      id: `${sync}.write`,
      definedIn: import.meta.url,
      access: 'call',
      targets: ['write', 'truncate', 'flush', 'close'].map(method => `${sync}.${method}`),
      policy: { kind: 'tracked', effects: writes, reason: 'Synchronous file mutation and commit/control are storage operations, not memory-buffer writes.' },
      evaluate: input => {
        passiveArguments(input); return SCALAR;
      },
    },
    {
      id: `${sync}.read`,
      definedIn: import.meta.url,
      access: 'call',
      targets: ['read', 'getSize'].map(method => `${sync}.${method}`),
      policy: { kind: 'tracked', effects: reads, reason: 'Synchronous file contents and size queries read content storage.' },
      evaluate: input => {
        passiveArguments(input); return SCALAR;
      },
    },
    {
      id: `${file}.identity-fields`,
      definedIn: import.meta.url,
      access: 'read',
      targets: [file, directory].flatMap(receiver => ['name', 'kind'].map(field => `${receiver}.${field}`)),
      policy: { kind: 'intentional-none', reason: 'Already acquired handle identity fields are in-memory metadata, not a new filesystem lookup.' },
      evaluate: (): Value => SCALAR,
    },
  ] satisfies readonly OperationRule[];
});
