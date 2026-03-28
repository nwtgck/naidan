import { computed, ref } from 'vue';
import { storageService } from '@/services/storage';
import { useSettings } from '@/composables/useSettings';
import { createFileProtocolCompatibleWeshWorkerClient } from '@/services/wesh-worker-client';
import type { WeshMount } from '@/services/wesh/types';

type TerminalLine =
  | { kind: 'system'; text: string }
  | { kind: 'command'; text: string }
  | { kind: 'stdout'; text: string }
  | { kind: 'stderr'; text: string }
  | { kind: 'error'; text: string };

type SessionState = 'initializing' | 'ready' | 'running' | 'error';

type DebugWeshSession = {
  id: string;
  title: string;
  lines: TerminalLine[];
  input: string;
  state: SessionState;
  errorMessage: string | undefined;
  client: Awaited<ReturnType<typeof createFileProtocolCompatibleWeshWorkerClient>> | undefined;
};

const sessions = ref<DebugWeshSession[]>([]);
const activeSessionId = ref<string | undefined>(undefined);
let nextSessionNumber = 1;

function createSessionId() {
  const id = `session-${nextSessionNumber}`;
  nextSessionNumber += 1;
  return id;
}

async function buildWorkerMounts() {
  const { settings } = useSettings();
  const mounts: WeshMount[] = [];
  for (const mount of settings.value.mounts) {
    if (mount.type !== 'volume') continue;
    const handle = await storageService.getVolumeDirectoryHandle({ volumeId: mount.volumeId });
    if (!handle) continue;
    mounts.push({
      path: mount.mountPath,
      handle,
      readOnly: mount.readOnly,
    });
  }
  return mounts;
}

async function createWorkerSession() {
  const id = createSessionId();
  const title = `Session ${sessions.value.length + 1}`;
  const session: DebugWeshSession = {
    id,
    title,
    lines: [],
    input: '',
    state: 'initializing',
    errorMessage: undefined,
    client: undefined,
  };
  sessions.value = [...sessions.value, session];
  activeSessionId.value = id;

  try {
    if (!navigator.storage || typeof navigator.storage.getDirectory !== 'function') {
      throw new Error('OPFS is not supported in this environment.');
    }

    const root = await navigator.storage.getDirectory();
    const debugRoot = await root.getDirectoryHandle('naidan-debug-wesh', { create: true });
    const globalRoot = await debugRoot.getDirectoryHandle('global', { create: true });
    const mounts = await buildWorkerMounts();

    const client = await createFileProtocolCompatibleWeshWorkerClient({
      rootHandle: globalRoot as unknown as FileSystemDirectoryHandle,
      mounts,
      user: 'debug',
      initialEnv: {},
      initialCwd: undefined,
    });

    session.client = client;
    session.state = 'ready';
    session.lines.push({ kind: 'system', text: 'Ready.' });
  } catch (error) {
    session.state = 'error';
    session.errorMessage = error instanceof Error ? error.message : String(error);
    session.lines.push({ kind: 'error', text: session.errorMessage });
  }
}

async function ensureActiveSession() {
  if (activeSessionId.value && sessions.value.some(session => session.id === activeSessionId.value)) {
    return;
  }
  if (sessions.value.length > 0) {
    activeSessionId.value = sessions.value[0]?.id;
    return;
  }
  await createWorkerSession();
}

const activeSession = computed(() => {
  return sessions.value.find(session => session.id === activeSessionId.value);
});

async function runCommand({ script }: { script: string }) {
  const session = activeSession.value;
  if (!session || !session.client || !script.trim()) return;
  const client = session.client;

  const outputLimitBytes = 32768;
  let executionId: string | undefined;
  let pendingCancellation = false;
  let cancellationRequested = false;
  let cancellationPromise: Promise<void> | undefined;
  const streamState: Record<'stdout' | 'stderr', {
    limit: number;
    bytes: number;
    truncated: boolean;
    decoder: TextDecoder;
  }> = {
    stdout: {
      limit: outputLimitBytes,
      bytes: 0,
      truncated: false,
      decoder: new TextDecoder(),
    },
    stderr: {
      limit: outputLimitBytes,
      bytes: 0,
      truncated: false,
      decoder: new TextDecoder(),
    },
  };

  const startCancellation = () => {
    if (!executionId) {
      return;
    }
    cancellationRequested = true;
    cancellationPromise = client.cancelExecution({ request: { executionId } })
      .catch(() => {})
      .then(() => {});
  };

  const requestCancellation = () => {
    if (cancellationRequested) {
      return;
    }
    if (executionId) {
      startCancellation();
      return;
    }
    pendingCancellation = true;
  };

  const consumeOutputChunk = async ({ stream, chunk }: {
    stream: 'stdout' | 'stderr';
    chunk: Uint8Array;
  }) => {
    const state = streamState[stream];
    if (state.truncated) {
      return;
    }

    const remaining = Math.max(0, state.limit - state.bytes);
    const acceptedLength = Math.min(chunk.byteLength, remaining);
    if (acceptedLength > 0) {
      const acceptedChunk = chunk.subarray(0, acceptedLength);
      state.bytes += acceptedChunk.byteLength;
      const text = state.decoder.decode(acceptedChunk, { stream: true });
      if (text) {
        session.lines.push({ kind: stream, text });
      }
    }

    if (acceptedLength < chunk.byteLength) {
      state.truncated = true;
      session.lines.push({ kind: 'error', text: `${stream} truncated due to size limit` });
      requestCancellation();
    }
  };

  const flushOutput = ({ stream }: { stream: 'stdout' | 'stderr' }) => {
    const state = streamState[stream];
    const text = state.decoder.decode();
    if (text) {
      session.lines.push({ kind: stream, text });
    }
  };

  session.input = '';
  session.lines.push({ kind: 'command', text: script });
  session.state = 'running';

  try {
    const started = await client.startExecution({
      request: {
        script,
      },
      onEvent: async (event) => {
        switch (event.type) {
        case 'started':
          break;
        case 'stdout':
          await consumeOutputChunk({ stream: 'stdout', chunk: event.chunk });
          break;
        case 'stderr':
          await consumeOutputChunk({ stream: 'stderr', chunk: event.chunk });
          break;
        case 'exit':
          break;
        case 'error':
          session.lines.push({ kind: 'error', text: event.message });
          break;
        default: {
          const _ex: never = event;
          throw new Error(`Unhandled wesh debug event: ${String(_ex)}`);
        }
        }
      },
    });
    executionId = started.executionId;
    if (pendingCancellation) {
      requestCancellation();
    }
    if (!executionId) {
      throw new Error('Wesh execution did not return an execution id');
    }
    const activeExecutionId = executionId;
    const result = await client.awaitExecution({
      request: {
        executionId: activeExecutionId,
      },
    });
    flushOutput({ stream: 'stdout' });
    flushOutput({ stream: 'stderr' });
    if (result.exitCode !== 0) {
      session.lines.push({ kind: 'error', text: `Process exited with code ${result.exitCode}` });
    }
    await cancellationPromise;
    await client.disposeExecution({ request: { executionId: activeExecutionId } });
  } catch (error) {
    session.lines.push({ kind: 'error', text: `Execution failed: ${error instanceof Error ? error.message : String(error)}` });
  } finally {
    session.state = 'ready';
  }
}

async function closeSession({ sessionId }: { sessionId: string }) {
  const session = sessions.value.find(item => item.id === sessionId);
  if (!session) return;
  await session.client?.dispose({});
  sessions.value = sessions.value.filter(item => item.id !== sessionId);
  if (activeSessionId.value === sessionId) {
    activeSessionId.value = sessions.value[0]?.id;
  }
}

async function reopenSessionIfNeeded() {
  await ensureActiveSession();
}

export function useDebugWeshTerminalSessions() {
  return {
    sessions,
    activeSession,
    activeSessionId,
    ensureActiveSession,
    createWorkerSession,
    closeSession,
    runCommand,
    reopenSessionIfNeeded,
    __testOnly: {
      buildWorkerMounts,
    },
  };
}
