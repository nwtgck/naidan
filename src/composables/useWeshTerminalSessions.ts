import { computed, ref } from 'vue';
import { createFileProtocolCompatibleWeshWorkerClient } from '@/services/wesh/worker/client';
import type { WeshMount } from '@/services/wesh/types';

export type WeshTerminalLineKind = 'system' | 'command' | 'stdout' | 'stderr' | 'error';

export interface WeshTerminalLine {
  id: number;
  kind: WeshTerminalLineKind;
  text: string;
}

export type WeshTerminalSessionState = 'initializing' | 'ready' | 'running' | 'error';

export interface WeshTerminalSession {
  id: string;
  title: string;
  lines: WeshTerminalLine[];
  state: WeshTerminalSessionState;
  errorMessage: string | undefined;
}

type WeshWorkerClient = Awaited<ReturnType<typeof createFileProtocolCompatibleWeshWorkerClient>>;

// Internal session type — extends the public interface with runtime-only fields.
// Used only inside this factory; the public API types everything as WeshTerminalSession.
interface InternalSession extends WeshTerminalSession {
  _client: WeshWorkerClient | undefined;
}

export function createWeshTerminalSessions({
  opfsRootName,
  user,
  initialEnv,
  initialCwd,
}: {
  opfsRootName: string;
  user: string;
  initialEnv: Record<string, string>;
  initialCwd: string | undefined;
}) {
  const sessionsInternal = ref<InternalSession[]>([]);
  const activeSessionId = ref<string | undefined>(undefined);
  let nextSessionNumber = 1;
  let lineIdCounter = 0;

  // Cancel callbacks for currently-running commands, keyed by session id.
  const cancelFns = new Map<string, () => void>();

  function mkLine({ kind, text }: { kind: WeshTerminalLineKind; text: string }): WeshTerminalLine {
    return { id: lineIdCounter++, kind, text };
  }

  // Exposed as WeshTerminalSession[] — callers cannot see _client.
  const sessions = computed<WeshTerminalSession[]>(() => sessionsInternal.value);

  const activeSession = computed<WeshTerminalSession | undefined>(() =>
    sessionsInternal.value.find(s => s.id === activeSessionId.value)
  );

  async function createSession({ buildMounts }: { buildMounts: () => Promise<WeshMount[]> }) {
    const id = `session-${nextSessionNumber++}`;
    const session: InternalSession = {
      id,
      title: `Session ${sessionsInternal.value.length + 1}`,
      lines: [],
      state: 'initializing',
      errorMessage: undefined,
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
            if (text) session.lines.push(mkLine({ kind: 'stdout', text }));
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

      if (cancelRequested) {
        session.lines.push(mkLine({ kind: 'system', text: '^C' }));
      } else if (result.exitCode !== 0) {
        session.lines.push(mkLine({ kind: 'error', text: `Exited with code ${result.exitCode}` }));
      }

      await client.disposeExecution({ request: { executionId: activeExecId } });
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
    await session._client?.dispose({});
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
    cancelRunningCommand,
    closeSession,
  };
}

export type WeshTerminalStore = ReturnType<typeof createWeshTerminalSessions>;
