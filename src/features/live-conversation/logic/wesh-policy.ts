import { z } from 'zod';
import type { LiveAnswer } from '@/features/llama-cpp-browser/live-types';
export const liveShellArgsSchema = z.object({
  shell_script: z.string().min(1).max(8192),
  stdout_limit: z.number().int().min(1).max(16384).optional(),
  stderr_limit: z.number().int().min(1).max(8192).optional(),
  timeout_ms: z.number().int().min(1).max(15000).optional(),
}).strict();
export type LiveToolCall = LiveAnswer['toolCalls'][number];

export function readLiveShellCall({ call }: { call: LiveToolCall }): z.infer<typeof liveShellArgsSchema> {
  if (call.function.name !== 'shell_execute') {
    throw new Error('Live conversation only permits shell_execute');
  }
  if (call.function.arguments.length > 16384) {
    throw new Error('Shell arguments exceed the live session limit');
  }
  return liveShellArgsSchema.parse(JSON.parse(call.function.arguments));
}

export const TEST_ONLY = {
};
