import { z } from 'zod';
import type { Tool, ToolExecutionEvent } from '@/01-models/tool';
import type { ToolApprovalContext } from '@/features/tools/approval';
import type { WeshMount } from '@/features/wesh/types';
import type { WeshWorkerClient } from '@/features/wesh/worker/types';

export interface WeshToolOptions {
  client: WeshWorkerClient,
  mounts: WeshMount[],
  name: string,
  description: string | undefined,
  defaultStdoutLimit: number,
  defaultStderrLimit: number,
  onOutputLimit?: ({ stream }: { stream: 'stdout' | 'stderr' }) => void,
}

/**
 * Creates a tool that executes shell commands using the Wesh service.
 * The tool name and description are configurable to hide the "Wesh" name from the LM if desired.
 */
export function createWeshTool({
  client,
  mounts,
  name,
  description,
  defaultStdoutLimit,
  defaultStderrLimit,
  onOutputLimit,
}: { client: WeshToolOptions['client'], mounts: WeshToolOptions['mounts'], name: WeshToolOptions['name'], description: WeshToolOptions['description'], defaultStdoutLimit: WeshToolOptions['defaultStdoutLimit'], defaultStderrLimit: WeshToolOptions['defaultStderrLimit'], onOutputLimit?: WeshToolOptions['onOutputLimit'] }): Tool {
  const createGenerationAbortedError = () => {
    const error = new Error('Generation aborted');
    error.name = 'AbortError';
    return error;
  };

  const mountList = mounts.length > 0
    ? `\n\nMounted directories:\n${mounts.map(m => `- ${m.path} (${m.readOnly ? 'read-only' : 'read-write'})`).join('\n')}`
    : '';

  const toolDescription = description ??
    `Execute shell scripts to perform file operations, system exploration, and data processing. You can use standard Unix-like commands (ls, cat, grep, etc.). Use the "help" command to see available utilities. This is useful for reading multiple files at once or performing complex file manipulations.${mountList}`;

  const WeshArgsSchema = z.object({
    shell_script: z.string().describe('The shell script or command to execute.'),
    stdout_limit: z
      .number()
      .default(defaultStdoutLimit)
      .describe('Maximum number of bytes to capture from stdout.'),
    stderr_limit: z
      .number()
      .default(defaultStderrLimit)
      .describe('Maximum number of bytes to capture from stderr.'),
    timeout_ms: z
      .number()
      .int()
      .min(0)
      .default(8000)
      .describe('Maximum execution time in milliseconds before the command is interrupted. Defaults to 8000 ms.'),
  });

  return {
    name,
    description: toolDescription,
    parametersSchema: WeshArgsSchema,
    async dispose() {
      await client.dispose();
    },

    async execute({
      args,
      signal,
      onEvent,
      approvalContext: _approvalContext,
    }: {
      args: unknown,
      signal?: AbortSignal,
      onEvent?: ({ event }: { event: ToolExecutionEvent }) => void | Promise<void>,
      approvalContext?: ToolApprovalContext,
    }) {
      let abortHandler: (() => void) | undefined;
      let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
      try {
        if (signal?.aborted) {
          throw createGenerationAbortedError();
        }
        const validated = WeshArgsSchema.parse(args);

        let stdoutText = '';
        let stderrText = '';
        let cancelExecution = () => {};
        let cancellationRequested = false;

        const streamState: Record<'stdout' | 'stderr', {
          limit: number,
          bytes: number,
          truncated: boolean,
          decoder: TextDecoder,
        }> = {
          stdout: {
            limit: validated.stdout_limit,
            bytes: 0,
            truncated: false,
            decoder: new TextDecoder(),
          },
          stderr: {
            limit: validated.stderr_limit,
            bytes: 0,
            truncated: false,
            decoder: new TextDecoder(),
          },
        };

        const appendOutput = ({ stream, text }: { stream: 'stdout' | 'stderr', text: string }) => {
          switch (stream) {
          case 'stdout':
            stdoutText += text;
            break;
          case 'stderr':
            stderrText += text;
            break;
          default: {
            const _ex: never = stream;
            throw new Error(`Unhandled wesh output stream: ${_ex}`);
          }
          }
        };

        const requestCancellation = () => {
          if (!cancellationRequested) {
            cancellationRequested = true;
            cancelExecution();
          }
        };

        const consumeOutputChunk = async ({ stream, chunk }: {
          stream: 'stdout' | 'stderr',
          chunk: Uint8Array,
        }) => {
          const state = streamState[stream];
          if (state.truncated) {
            return;
          }

          const remaining = Math.max(0, state.limit - state.bytes);
          const acceptedLength = Math.min(chunk.byteLength, remaining);
          const truncated = acceptedLength < chunk.byteLength;
          if (truncated) {
            state.truncated = true;
            requestCancellation();
            onOutputLimit?.({ stream });
          }

          if (acceptedLength > 0) {
            const acceptedChunk = chunk.subarray(0, acceptedLength);
            state.bytes += acceptedChunk.byteLength;
            const text = state.decoder.decode(acceptedChunk, { stream: true });
            if (text) {
              appendOutput({ stream, text });
              await onEvent?.({ event: { type: 'output', stream, text } });
            }
          }
        };

        const flushOutput = ({ stream }: { stream: 'stdout' | 'stderr' }) => {
          const state = streamState[stream];
          const text = state.decoder.decode();
          if (text) {
            appendOutput({ stream, text });
          }
          if (state.truncated) {
            appendOutput({ stream, text: '\n[Output truncated due to size limit]' });
          }
        };

        const execution = client.startExecution({
          request: {
            script: validated.shell_script,
          },
          onEvent: async ({ event }) => {
            switch (event.type) {
            case 'started':
              await onEvent?.({ event: { type: 'started' } });
              break;
            case 'stdout':
              await consumeOutputChunk({ stream: 'stdout', chunk: event.chunk });
              break;
            case 'stderr':
              await consumeOutputChunk({ stream: 'stderr', chunk: event.chunk });
              break;
            case 'exit':
              await onEvent?.({ event: { type: 'exit', exitCode: event.exitCode } });
              break;
            case 'error':
              throw new Error(event.message);
            default: {
              const _ex: never = event;
              throw new Error(`Unhandled wesh execution event: ${String(_ex)}`);
            }
            }
          },
        });
        cancelExecution = () => execution.cancel();
        if (cancellationRequested || signal?.aborted) {
          cancellationRequested = true;
          execution.cancel();
        }
        if (signal) {
          abortHandler = requestCancellation;
          signal.addEventListener('abort', abortHandler, { once: true });
        }

        let timedOut = false;
        timeoutHandle = setTimeout(() => {
          timedOut = true;
          requestCancellation();
        }, validated.timeout_ms);
        const result = await execution.completion;
        if (signal?.aborted) {
          throw createGenerationAbortedError();
        }
        flushOutput({ stream: 'stdout' });
        flushOutput({ stream: 'stderr' });

        let content: string;
        let terminated = false;
        switch (result.status) {
        case 'exited':
          content = `Exit Code: ${result.exitCode}\n`;
          break;
        case 'terminated':
          terminated = true;
          content = 'Shell worker terminated.\n';
          break;
        default: {
          const exhaustive: never = result;
          throw new Error(String(exhaustive));
        }
        }

        if (stdoutText) {
          content += `\nSTDOUT:\n${stdoutText}\n`;
        }
        if (stderrText) {
          content += `\nSTDERR:\n${stderrText}\n`;
        }

        if (timedOut) {
          return {
            status: 'error',
            code: 'timeout',
            message: `Shell execution timed out after ${validated.timeout_ms}ms.\n\n${content}`,
          };
        }

        if (terminated) {
          return { status: 'error', code: 'execution_failed', message: content };
        }

        return {
          status: 'success',
          content,
        };
      } catch (error) {
        if (signal?.aborted) {
          throw createGenerationAbortedError();
        }
        if (error instanceof Error && (error.name === 'AbortError' || error.message === 'Generation aborted')) {
          throw error;
        }
        return {
          status: 'error',
          code: 'execution_failed',
          message: `Shell execution error: ${error instanceof Error ? error.message : String(error)}`,
        };
      } finally {
        if (timeoutHandle !== undefined) {
          clearTimeout(timeoutHandle);
        }
        if (signal && abortHandler) {
          signal.removeEventListener('abort', abortHandler);
        }
      }
    },
  };
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
