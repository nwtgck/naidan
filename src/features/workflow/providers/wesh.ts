import { storageService } from '@/00-storage/service';
import type { VolumeId } from '@/01-models/ids';
import { createFileProtocolCompatibleWeshWorkerClient } from '@/features/wesh/worker/client';
import { volumeAccessToWeshMount } from '@/features/wesh/volume-mount';
import { createWeshTool } from '@/features/tools/wesh';
import type { WorkflowToolRequest } from '@/features/workflow/logic/tool-input';
import type { WorkflowToolExecution } from '@/features/workflow/logic/tool-execution';

/** Fresh shell per Step. Only /workspace is mounted; no chat/sysfs/global
 * settings mounts or implicit scratch files. Persistent files are never removed
 * by closing a shell, and stopping cannot roll back commands already completed. */
export async function openWorkflowShell({ volumeId, access, signal }: {
  volumeId: VolumeId, access: 'read-only' | 'read-write', signal: AbortSignal,
}) {
  signal.throwIfAborted();
  const resolved = await storageService.resolveVolumeAccess({ volumeId });
  signal.throwIfAborted();
  const mount = volumeAccessToWeshMount({ mount: { type: 'volume', volumeId, mountPath: '/workspace', readOnly: access === 'read-only' }, access: resolved });
  if (!mount) {
    throw new Error('Workflow shell folder is missing or incomplete.');
  }
  const client = await createFileProtocolCompatibleWeshWorkerClient({ rootHandle: 'readonly', mounts: [mount], user: 'user', initialEnv: {}, initialCwd: '/workspace' });
  try {
    signal.throwIfAborted();
    const truncatedStreams = new Set<'stdout' | 'stderr'>();
    const tool = createWeshTool({
      client,
      mounts: [mount],
      name: 'shell_execute',
      description: undefined,
      defaultStdoutLimit: 16384,
      defaultStderrLimit: 8192,
      onOutputLimit: ({ stream }) => {
        truncatedStreams.add(stream);
      },
    });
    let closed = false;
    return {
      async execute({ args, signal: operationSignal }: { args: Extract<WorkflowToolRequest, { name: 'shell_execute' }>['args'], signal: AbortSignal }): Promise<WorkflowToolExecution> {
        if (closed) {
          throw new Error('Workflow shell is closed.');
        }
        operationSignal.throwIfAborted();
        truncatedStreams.clear();
        let exitCode: number | undefined;
        const outcome = await tool.execute({
          args,
          signal: operationSignal,
          onEvent({ event }) {
            switch (event.type) {
            case 'exit': exitCode = event.exitCode;
              break;
            case 'started': case 'output': break;
            default: {
              const exhaustive: never = event;
              throw new Error(String(exhaustive));
            }
            }
          },
        });
        operationSignal.throwIfAborted();
        if (outcome.status === 'success' && exitCode === undefined) {
          throw new Error('Shell finished without an exit status.');
        }
        return {
          outcome: outcome.status === 'success' && (exitCode !== 0 || truncatedStreams.size > 0) ? { status: 'error', code: 'execution_failed', message: outcome.content } : outcome,
          metadata: { ...(exitCode === undefined ? {} : { exitCode }), truncated: truncatedStreams.size > 0, truncatedStreams: [...truncatedStreams] },
        };
      },
      async close(): Promise<void> {
        if (!closed) {
          closed = true;
          await client.dispose();
        }
      },
    };
  } catch (error) {
    await client.dispose();
    throw error;
  }
}

export const TEST_ONLY = {
};
