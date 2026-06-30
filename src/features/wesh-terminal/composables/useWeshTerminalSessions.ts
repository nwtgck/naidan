import { ensureStrings } from '@/strings';
import { computed, ref } from 'vue';
import { createFileProtocolCompatibleWeshWorkerClient } from '@/features/wesh/worker/client';
import {
  completeCommandToken,
  completePathToken,
  getTerminalCompletionToken,
  splitPathToken,
  type WeshTerminalCompletionResult,
} from '@/features/wesh-terminal/utils/terminalCompletion';
import type { WeshWorkerShellState } from '@/features/wesh/worker/types';
import type { WeshMount } from '@/features/wesh/types';

export type WeshTerminalLineKind = 'system' | 'command' | 'stdout' | 'stderr' | 'error';

export interface WeshTerminalLine {
  id: number,
  kind: WeshTerminalLineKind,
  text: string,
}

export type WeshTerminalSessionState = 'initializing' | 'ready' | 'running' | 'error';

export interface WeshTerminalSession {
  id: string,
  title: string,
  lines: WeshTerminalLine[],
  state: WeshTerminalSessionState,
  errorMessage: string | undefined,
  shellState: WeshWorkerShellState | undefined,
  lastExitCode: number | undefined,
}

type WeshWorkerClient = Awaited<ReturnType<typeof createFileProtocolCompatibleWeshWorkerClient>>;

// Internal session type — extends the public interface with runtime-only fields.
// Used only inside this factory; the public API types everything as WeshTerminalSession.
interface InternalSession extends WeshTerminalSession {
  _client: WeshWorkerClient | undefined,
}

async function ensureDirectoryPath({
  rootHandle,
  path,
}: {
  rootHandle: FileSystemDirectoryHandle,
  path: string,
}): Promise<void> {
  const segments = path.split('/').filter(segment => segment.length > 0);
  let current = rootHandle;
  for (const segment of segments) {
    current = await current.getDirectoryHandle(segment, { create: true });
  }
}

async function ensureTerminalBaseDirectories({
  rootHandle,
  homeDirectory,
  tmpDirectory,
}: {
  rootHandle: FileSystemDirectoryHandle,
  homeDirectory: string | undefined,
  tmpDirectory: string | undefined,
}) {
  if (homeDirectory !== undefined) {
    await ensureDirectoryPath({ rootHandle, path: homeDirectory });
  }
  if (tmpDirectory !== undefined) {
    await ensureDirectoryPath({ rootHandle, path: tmpDirectory });
  }
}

function shouldClearTerminalOutput({ text }: { text: string }): boolean {
  return text === '\u001b[2J\u001b[H' || text === '\u001bc';
}

export function createWeshTerminalSessions({
  opfsRootName,
  user,
  initialEnv,
  initialCwd,
  homeDirectory,
  tmpDirectory,
}: {
  opfsRootName: string,
  user: string,
  initialEnv: Record<string, string>,
  initialCwd: string | undefined,
  homeDirectory: string | undefined,
  tmpDirectory: string | undefined,
}) {
  const sessionsInternal = ref<InternalSession[]>([]);
  const activeSessionId = ref<string | undefined>(undefined);
  let nextSessionNumber = 1;
  let lineIdCounter = 0;

  // Cancel callbacks for currently-running commands, keyed by session id.
  const cancelFns = new Map<string, () => void>();

  function mkLine({ kind, text }: { kind: WeshTerminalLineKind, text: string }): WeshTerminalLine {
    return { id: lineIdCounter++, kind, text };
  }

  // Exposed as WeshTerminalSession[] — callers cannot see _client.
  const sessions = computed<WeshTerminalSession[]>(() => sessionsInternal.value);

  const activeSession = computed<WeshTerminalSession | undefined>(() =>
    sessionsInternal.value.find(s => s.id === activeSessionId.value),
  );

  async function refreshShellState({ session }: { session: InternalSession }) {
    const client = session._client;
    if (!client || typeof client.getShellState !== 'function') return;
    session.shellState = await client.getShellState();
  }

  async function createSession({ buildMounts }: { buildMounts: () => Promise<WeshMount[]> }) {
    const id = `session-${nextSessionNumber++}`;
    const session: InternalSession = {
      id,
      title: await ensureStrings.weshTerminal__session({ sessionNumber: nextSessionNumber - 1 }),
      lines: [],
      state: 'initializing',
      errorMessage: undefined,
      shellState: undefined,
      lastExitCode: undefined,
      _client: undefined,
    };
    sessionsInternal.value = [...sessionsInternal.value, session];
    activeSessionId.value = id;

    try {
      if (!navigator.storage || typeof navigator.storage.getDirectory !== 'function') {
        throw new Error('OPFS is not available in this environment.');
      }
      const root = await navigator.storage.getDirectory();
      const termRoot = await root.getDirectoryHandle(opfsRootName, { create: true });
      const globalRoot = await termRoot.getDirectoryHandle('global', { create: true });
      await ensureTerminalBaseDirectories({
        rootHandle: globalRoot as unknown as FileSystemDirectoryHandle,
        homeDirectory,
        tmpDirectory,
      });
      const mounts = await buildMounts();

      const client = await createFileProtocolCompatibleWeshWorkerClient({
        rootHandle: globalRoot as unknown as FileSystemDirectoryHandle,
        mounts,
        user,
        initialEnv,
        initialCwd,
      });

      // Mutate through the reactive proxy so Vue tracks the state change.
      const reactiveSession = sessionsInternal.value.find(s => s.id === id) as InternalSession;
      reactiveSession._client = client;
      await refreshShellState({ session: reactiveSession });
      reactiveSession.state = 'ready';
      reactiveSession.lines.push(mkLine({ kind: 'system', text: 'Ready.' }));
    } catch (err) {
      const reactiveSession = sessionsInternal.value.find(s => s.id === id) as InternalSession;
      const msg = err instanceof Error ? err.message : String(err);
      reactiveSession.state = 'error';
      reactiveSession.errorMessage = msg;
      reactiveSession.lines.push(mkLine({ kind: 'error', text: msg }));
    }
  }

  async function ensureSession({ buildMounts }: { buildMounts: () => Promise<WeshMount[]> }) {
    if (activeSessionId.value && sessionsInternal.value.some(s => s.id === activeSessionId.value)) {
      return;
    }
    if (sessionsInternal.value.length > 0) {
      activeSessionId.value = sessionsInternal.value[0]?.id;
      return;
    }
    await createSession({ buildMounts });
  }

  async function completeInput({
    sessionId,
    line,
    cursor,
  }: {
    sessionId: string,
    line: string,
    cursor: number,
  }): Promise<WeshTerminalCompletionResult> {
    const session = sessionsInternal.value.find(s => s.id === sessionId);
    if (!session?._client) {
      return { replacement: undefined, candidates: [] };
    }

    const token = getTerminalCompletionToken({ line, cursor });
    switch (token.role) {
    case 'command': {
      const commands = await session._client.listCommands();
      return completeCommandToken({ token, commands });
    }
    case 'path': {
      const { directoryPath } = splitPathToken({ tokenText: token.text });
      const entries = await session._client.listDirectory({ request: { path: directoryPath } });
      return completePathToken({ token, entries });
    }
    default: {
      const _ex: never = token.role;
      return _ex;
    }
    }
  }

  async function runCommand({ script }: { script: string }) {
    const session = sessionsInternal.value.find(s => s.id === activeSessionId.value);
    if (!session || !session._client || session.state !== 'ready' || !script.trim()) return;
    const client = session._client;

    let executionId: string | undefined;
    let pendingCancel = false;
    let cancelRequested = false;
    let cancelPromise: Promise<void> | undefined;

    const stdoutDec = new TextDecoder();
    const stderrDec = new TextDecoder();

    const doCancel = () => {
      if (cancelRequested || !executionId) return;
      cancelRequested = true;
      cancelPromise = client.cancelExecution({ request: { executionId } })
        .catch(() => {})
        .then(() => {});
    };

    cancelFns.set(session.id, () => {
      if (executionId) {
        doCancel();
      } else {
        pendingCancel = true;
      }
    });

    session.lines.push(mkLine({ kind: 'command', text: script }));
    session.state = 'running';

    try {
      const started = await client.startExecution({
        request: { script },
        onEvent: async ({ event }) => {
          switch (event.type) {
          case 'started':
            break;
          case 'stdout': {
            const text = stdoutDec.decode(event.chunk, { stream: true });
            if (shouldClearTerminalOutput({ text })) {
              session.lines = [];
            } else if (text) {
              session.lines.push(mkLine({ kind: 'stdout', text }));
            }
            break;
          }
          case 'stderr': {
            const text = stderrDec.decode(event.chunk, { stream: true });
            if (text) session.lines.push(mkLine({ kind: 'stderr', text }));
            break;
          }
          case 'exit':
            break;
          case 'error':
            session.lines.push(mkLine({ kind: 'error', text: event.message }));
            break;
          default: {
            const _ex: never = event;
            throw new Error(`Unhandled wesh event: ${String(_ex)}`);
          }
          }
        },
      });

      executionId = started.executionId;
      if (pendingCancel) doCancel();
      if (!executionId) throw new Error('Worker did not return an execution id.');

      const activeExecId = executionId;
      const result = await client.awaitExecution({ request: { executionId: activeExecId } });

      // Flush any bytes still buffered in the UTF-8 decoders.
      const tailOut = stdoutDec.decode();
      if (tailOut) session.lines.push(mkLine({ kind: 'stdout', text: tailOut }));
      const tailErr = stderrDec.decode();
      if (tailErr) session.lines.push(mkLine({ kind: 'stderr', text: tailErr }));

      await cancelPromise;
      session.lastExitCode = result.exitCode;

      if (cancelRequested) {
        session.lines.push(mkLine({ kind: 'system', text: '^C' }));
      }

      await client.disposeExecution({ request: { executionId: activeExecId } });
      await refreshShellState({ session });
    } catch (err) {
      session.lines.push(mkLine({ kind: 'error', text: err instanceof Error ? err.message : String(err) }));
    } finally {
      cancelFns.delete(session.id);
      session.state = 'ready';
    }
  }

  function cancelRunningCommand({ sessionId }: { sessionId: string }) {
    cancelFns.get(sessionId)?.();
  }

  async function closeSession({ sessionId }: { sessionId: string }) {
    const session = sessionsInternal.value.find(s => s.id === sessionId);
    if (!session) return;
    cancelFns.delete(sessionId);
    await session._client?.dispose();
    sessionsInternal.value = sessionsInternal.value.filter(s => s.id !== sessionId);
    if (activeSessionId.value === sessionId) {
      activeSessionId.value = sessionsInternal.value[0]?.id;
    }
  }

  return {
    sessions,
    activeSessionId,
    activeSession,
    createSession,
    ensureSession,
    runCommand,
    completeInput,
    cancelRunningCommand,
    closeSession,
  };
}

export type WeshTerminalStore = ReturnType<typeof createWeshTerminalSessions>;
export const TEST_ONLY = (__BUILD_MODE_IS_TEST__ && {
  ensureDirectoryPath,
  shouldClearTerminalOutput,
}) || undefined;
