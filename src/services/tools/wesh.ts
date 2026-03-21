import { z } from 'zod';
import type { Tool } from './types';
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
  });

  return {
    name,
    description: toolDescription,
    parametersSchema: WeshArgsSchema,
    async dispose() {
      await client.dispose();
    },

    async execute({ args, signal }: { args: unknown; signal?: AbortSignal }) {
      let abortHandler: (() => void) | undefined;
      try {
        if (signal?.aborted) throw new Error('Generation aborted');
        const validated = WeshArgsSchema.parse(args);
        if (signal) {
          abortHandler = () => {
            void client.interrupt();
          };
          signal.addEventListener('abort', abortHandler, { once: true });
        }

        const result = await client.execute({
          request: {
            script: validated.shell_script,
            stdoutLimit: validated.stdout_limit,
            stderrLimit: validated.stderr_limit,
          },
        });

        let content = `Exit Code: ${result.exitCode}\n`;
        const stdoutText = result.stdout;
        const stderrText = result.stderr;

        if (stdoutText) {
          content += `\nSTDOUT:\n${stdoutText}\n`;
        }
        if (stderrText) {
          content += `\nSTDERR:\n${stderrText}\n`;
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
        if (signal && abortHandler) {
          signal.removeEventListener('abort', abortHandler);
        }
      }
    },
  };
}
