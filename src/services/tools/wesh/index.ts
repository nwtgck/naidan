import { z } from 'zod';
import type { Tool, ToolExecutionEvent } from '@/services/tools/types';
import type { ToolApprovalContext } from '@/services/approval';
import type { WeshMount } from '@/services/wesh/types';
import type { WeshWorkerClient } from '@/services/wesh/worker/types';

export interface WeshToolOptions {
  client: WeshWorkerClient;
  mounts: WeshMount[];
  name: string;
  description: string | undefined;
  defaultStdoutLimit: number;
  defaultStderrLimit: number;
}

/**
 * Creates a tool that executes shell commands using the Wesh service.
 * The tool name and description are configurable to hide the "Wesh" name from the LLM if desired.
 */
export function createWeshTool({
  client,
  mounts,
  name,
  description,
  defaultStdoutLimit,
  defaultStderrLimit,
}: WeshToolOptions): Tool {
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
      args: unknown;
      signal?: AbortSignal;
      onEvent?: ({ event }: { event: ToolExecutionEvent }) => void | Promise<void>;
      approvalContext?: ToolApprovalContext;
    }) {
      let abortHandler: (() => void) | undefined;
      let abortPromiseCleanup: (() => void) | undefined;
      let executionId: string | undefined;
      let cancellationPromise: Promise<void> | undefined;
      try {
        if (signal?.aborted) throw new Error('Generation aborted');
        const validated = WeshArgsSchema.parse(args);

        let stdoutText = '';
        let stderrText = '';
        let pendingCancellation = false;
        let cancellationRequested = false;

        const streamState: Record<'stdout' | 'stderr', {
          limit: number;
          bytes: number;
          truncated: boolean;
          decoder: TextDecoder;
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

        const appendOutput = ({ stream, text }: { stream: 'stdout' | 'stderr'; text: string }) => {
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

        const startCancellation = () => {
          if (!executionId) {
            return;
          }
          cancellationRequested = true;
          cancellationPromise = client.cancelExecution({ request: { executionId } }).then(() => {});
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
              appendOutput({ stream, text });
              await onEvent?.({ event: { type: 'output', stream, text } });
            }
          }

          if (acceptedLength < chunk.byteLength) {
            state.truncated = true;
            requestCancellation();
          }
        };

        const flushOutput = async ({ stream }: { stream: 'stdout' | 'stderr' }) => {
          const state = streamState[stream];
          const text = state.decoder.decode();
          if (text) {
            appendOutput({ stream, text });
          }
          if (state.truncated) {
            appendOutput({ stream, text: '\n[Output truncated due to size limit]' });
          }
        };

        if (signal) {
          abortHandler = () => {
            if (executionId) {
              void client.cancelExecution({ request: { executionId } });
            } else {
              void client.interrupt();
            }
          };
          signal.addEventListener('abort', abortHandler, { once: true });
        }

        const started = await client.startExecution({
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
        executionId = started.executionId;
        if (pendingCancellation) {
          requestCancellation();
        }
        if (!executionId) {
          throw new Error('Wesh execution did not return an execution id');
        }
        const activeExecutionId = executionId;

        if (signal?.aborted) {
          await client.cancelExecution({
            request: {
              executionId: activeExecutionId,
            },
          });
          throw createGenerationAbortedError();
        }

        const abortPromise = signal ? new Promise<never>((_resolve, reject) => {
          const onAbort = () => {
            reject(createGenerationAbortedError());
          };
          abortPromiseCleanup = () => {
            signal.removeEventListener('abort', onAbort);
          };
          if (signal.aborted) {
            onAbort();
            return;
          }
          signal.addEventListener('abort', onAbort, { once: true });
        }) : undefined;

        let timedOut = false;
        const completion = client.awaitExecution({
          request: {
            executionId: activeExecutionId,
          },
        });
        const timeout = new Promise<'timeout'>(resolve => {
          setTimeout(() => resolve('timeout'), validated.timeout_ms);
        });
        const raceParticipants: Array<Promise<unknown>> = [completion, timeout];
        if (abortPromise) {
          raceParticipants.push(abortPromise);
        }
        const outcome = await Promise.race(raceParticipants);

        if (outcome === 'timeout') {
          timedOut = true;
          await client.cancelExecution({
            request: {
              executionId: activeExecutionId,
            },
          });
        }

        const result = await completion;
        await flushOutput({ stream: 'stdout' });
        await flushOutput({ stream: 'stderr' });

        let content = `Exit Code: ${result.exitCode}\n`;

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

        return {
          status: 'success',
          content,
        };
      } catch (error) {
        if (error instanceof Error && (error.name === 'AbortError' || error.message === 'Generation aborted')) {
          throw error;
        }
        return {
          status: 'error',
          code: 'execution_failed',
          message: `Shell execution error: ${error instanceof Error ? error.message : String(error)}`,
        };
      } finally {
        if (executionId) {
          await cancellationPromise;
          await client.disposeExecution({
            request: {
              executionId,
            },
          });
        }
        abortPromiseCleanup?.();
        if (signal && abortHandler) {
          signal.removeEventListener('abort', abortHandler);
        }
      }
    },
  };
}
