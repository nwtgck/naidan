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

  session.input = '';
  session.lines.push({ kind: 'command', text: script });
  session.state = 'running';

  try {
    const result = await session.client.execute({
      request: {
        script,
        stdoutLimit: 32768,
        stderrLimit: 32768,
      },
    });
    if (result.stdout) session.lines.push({ kind: 'stdout', text: result.stdout });
    if (result.stderr) session.lines.push({ kind: 'stderr', text: result.stderr });
    if (result.exitCode !== 0) {
      session.lines.push({ kind: 'error', text: `Process exited with code ${result.exitCode}` });
    }
  } catch (error) {
    session.lines.push({ kind: 'error', text: `Execution failed: ${error instanceof Error ? error.message : String(error)}` });
  } finally {
    session.state = 'ready';
  }
}

async function closeSession({ sessionId }: { sessionId: string }) {
  const session = sessions.value.find(item => item.id === sessionId);
  if (!session) return;
  await session.client?.dispose();
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
