import { z } from 'zod';
import type { Tool, ToolExecutionEvent } from './types';
import type { WeshMount } from '@/services/wesh/types';
import type { WeshWorkerClient } from '@/services/wesh-worker.types';

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
    timeoutMs: z
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
      await client.dispose({});
    },

    async execute({ args, signal, onEvent }: { args: unknown; signal?: AbortSignal; onEvent?: (event: ToolExecutionEvent) => void | Promise<void> }) {
      let abortHandler: (() => void) | undefined;
      let executionId: string | undefined;
      try {
        if (signal?.aborted) throw new Error('Generation aborted');
        const validated = WeshArgsSchema.parse(args);
        let stdoutText = '';
        let stderrText = '';

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

        if (signal) {
          abortHandler = () => {
            if (executionId) {
              void client.interruptExecution({ request: { executionId } });
            } else {
              void client.interrupt({});
            }
          };
          signal.addEventListener('abort', abortHandler, { once: true });
        }

        const started = await client.startExecution({
          request: {
            script: validated.shell_script,
            stdoutLimit: validated.stdout_limit,
            stderrLimit: validated.stderr_limit,
          },
          onEvent: async (event) => {
            switch (event.type) {
            case 'started':
              await onEvent?.({ type: 'started' });
              break;
            case 'stdout':
              appendOutput({ stream: 'stdout', text: event.text });
              await onEvent?.({ type: 'output', stream: 'stdout', text: event.text });
              break;
            case 'stderr':
              appendOutput({ stream: 'stderr', text: event.text });
              await onEvent?.({ type: 'output', stream: 'stderr', text: event.text });
              break;
            case 'exit':
              await onEvent?.({ type: 'exit', exitCode: event.exitCode });
              break;
            case 'stdout_truncated':
            case 'stderr_truncated':
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

        let timedOut = false;
        const completion = client.awaitExecution({
          request: {
            executionId,
          },
        });
        const timeout = new Promise<'timeout'>(resolve => {
          setTimeout(() => resolve('timeout'), validated.timeoutMs);
        });
        const outcome = await Promise.race([completion, timeout]);

        if (outcome === 'timeout') {
          timedOut = true;
          await client.interruptExecution({
            request: {
              executionId,
            },
          });
        }

        const result = await completion;
        stdoutText = result.stdout;
        stderrText = result.stderr;

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
            message: `Shell execution timed out after ${validated.timeoutMs}ms.\n\n${content}`,
          };
        }

        return {
          status: 'success',
          content,
        };
      } catch (error) {
        return {
          status: 'error',
          code: 'execution_failed',
          message: `Shell execution error: ${error instanceof Error ? error.message : String(error)}`,
        };
      } finally {
        if (executionId) {
          await client.disposeExecution({
            request: {
              executionId,
            },
          });
        }
        if (signal && abortHandler) {
          signal.removeEventListener('abort', abortHandler);
        }
      }
    },
  };
}
