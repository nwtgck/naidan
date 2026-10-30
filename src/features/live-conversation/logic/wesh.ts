import { liveShellArgsSchema, readLiveShellCall, type LiveToolCall } from './wesh-policy';
import { z } from 'zod';
import { storageService } from '@/00-storage/service';
import type { VolumeId } from '@/01-models/ids';
import { formatToolExecutionOutcomeForLm } from '@/01-models/tool';
import { createFileProtocolCompatibleWeshWorkerClient } from '@/features/wesh/worker/client';
import { volumeAccessToWeshMount } from '@/features/wesh/volume-mount';
import { createWeshTool } from '@/features/tools/wesh';
import { liveToolsSchema } from '@/features/llama-cpp-browser/live-types';

/** One explicitly selected Volume, no Chat/sysfs mounts. Ending a conversation
 * releases the Wesh process but never deletes its persistent files. */
export async function openLiveWesh({ volumeId, access, signal }: {
  volumeId: VolumeId, access: 'read-only' | 'read-write', signal: AbortSignal,
}) {
  signal.throwIfAborted();
  const resolved = await storageService.resolveVolumeAccess({ volumeId });
  signal.throwIfAborted();
  const mount = volumeAccessToWeshMount({ mount: { type: 'volume', volumeId, mountPath: '/workspace', readOnly: access === 'read-only' }, access: resolved });
  if (!mount) {
    throw new Error('Live Wesh folder is missing or incomplete');
  }
  const client = await createFileProtocolCompatibleWeshWorkerClient({ rootHandle: 'readonly', mounts: [mount], user: 'user', initialEnv: {}, initialCwd: '/workspace' });
  if (signal.aborted) {
    await client.dispose();
    signal.throwIfAborted();
  }
  try {
    const tool = createWeshTool({ client, mounts: [mount], name: 'shell_execute', description: undefined, defaultStdoutLimit: 16384, defaultStderrLimit: 8192 });
    let closed = false;
    return {
      tools: liveToolsSchema.parse([{ type: 'function', function: { name: tool.name, description: tool.description, parameters: z.toJSONSchema(liveShellArgsSchema) } }]),
      async execute({ call, signal: operationSignal }: { call: LiveToolCall, signal: AbortSignal }): Promise<string> {
        if (closed) {
          throw new Error('Live Wesh session is closed');
        }
        operationSignal.throwIfAborted();
        const args = readLiveShellCall({ call });
        const outcome = await tool.execute({ args: { ...args, stdout_limit: args.stdout_limit ?? 16384, stderr_limit: args.stderr_limit ?? 8192, timeout_ms: args.timeout_ms ?? 8000 }, signal: operationSignal });
        operationSignal.throwIfAborted();
        return formatToolExecutionOutcomeForLm({ outcome }).slice(0, 32768);
      },
      async close(): Promise<void> {
        if (closed) {
          return;
        }
        closed = true;
        await client.dispose();
      },
    };
  } catch (error) {
    await client.dispose();
    throw error;
  }
}

export type LiveWesh = Awaited<ReturnType<typeof openLiveWesh>>;
export const TEST_ONLY = {
};
