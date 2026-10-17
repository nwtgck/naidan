import {
  spawn,
  spawnSync,
  type ChildProcess,
  type ChildProcessByStdio,
  type ChildProcessWithoutNullStreams,
  type SpawnOptions,
  type SpawnOptionsWithoutStdio,
  type SpawnOptionsWithStdioTuple,
  type SpawnSyncOptions,
  type SpawnSyncOptionsWithBufferEncoding,
  type SpawnSyncOptionsWithStringEncoding,
  type SpawnSyncReturns,
  type StdioNull,
  type StdioPipe,
} from 'node:child_process';
import type { Readable, Writable } from 'node:stream';

type CommandArgv = readonly [string, ...string[]];
type WithoutShell<Options> = Omit<Options, 'shell'> & { shell?: false };
type PipeStream<Stdio, Stream> = Stdio extends StdioPipe ? Stream : null;

export function runCommand({ argv, options }: { argv: CommandArgv, options: WithoutShell<SpawnOptionsWithoutStdio> | undefined }): ChildProcessWithoutNullStreams;
export function runCommand<Stdin extends StdioNull | StdioPipe, Stdout extends StdioNull | StdioPipe, Stderr extends StdioNull | StdioPipe>({ argv, options }: {
  argv: CommandArgv,
  options: WithoutShell<SpawnOptionsWithStdioTuple<Stdin, Stdout, Stderr>>,
}): ChildProcessByStdio<PipeStream<Stdin, Writable>, PipeStream<Stdout, Readable>, PipeStream<Stderr, Readable>>;
export function runCommand({ argv, options }: { argv: CommandArgv, options: WithoutShell<SpawnOptions> | undefined }): ChildProcess;
export function runCommand({ argv, options }: { argv: CommandArgv, options: WithoutShell<SpawnOptions> | undefined }): ChildProcess {
  const [executable, ...args] = argv;
  return spawn(executable, args, { ...options, shell: false });
}

export function runCommandSync({ argv, options }: { argv: CommandArgv, options: WithoutShell<SpawnSyncOptionsWithStringEncoding> }): SpawnSyncReturns<string>;
export function runCommandSync({ argv, options }: { argv: CommandArgv, options: WithoutShell<SpawnSyncOptionsWithBufferEncoding> | undefined }): SpawnSyncReturns<NonSharedBuffer>;
export function runCommandSync({ argv, options }: { argv: CommandArgv, options: WithoutShell<SpawnSyncOptions> | undefined }): SpawnSyncReturns<string | NonSharedBuffer>;
export function runCommandSync({ argv, options }: { argv: CommandArgv, options: WithoutShell<SpawnSyncOptions> | undefined }): SpawnSyncReturns<string | NonSharedBuffer> {
  const [executable, ...args] = argv;
  return spawnSync(executable, args, { ...options, shell: false });
}
