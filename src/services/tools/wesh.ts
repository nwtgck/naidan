import { z } from 'zod';
import type { Tool } from './types';
import type { Wesh } from '@/services/wesh';
import type { WeshMount } from '@/services/wesh/types';
import { createWeshReadFileHandleFromText } from '@/services/wesh/utils/test-stream';
import { createWeshWriteFileHandle } from '@/services/wesh/utils/stream';

export interface WeshToolOptions {
  wesh: Wesh;
  mounts?: WeshMount[];
  name?: string;
  description?: string;
  defaultStdoutLimit?: number;
  defaultStderrLimit?: number;
}

/**
 * Creates a capture handle that stores data up to a certain limit.
 */
function createCaptureHandle({ limit }: { limit: number }) {
  let size = 0;
  const chunks: Uint8Array[] = [];
  let truncated = false;

  const handle = createWeshWriteFileHandle({
    target: new WritableStream({
      write(chunk) {
        if (truncated) return;
        if (size + chunk.length > limit) {
          const remaining = limit - size;
          if (remaining > 0) {
            chunks.push(new Uint8Array(chunk.subarray(0, remaining)));
            size = limit;
          }
          truncated = true;
          return;
        }
        chunks.push(new Uint8Array(chunk));
        size += chunk.length;
      },
    }),
  });

  return {
    handle,
    get text() {
      const decoder = new TextDecoder();
      let result = chunks.map(c => decoder.decode(c, { stream: true })).join('') + decoder.decode();
      if (truncated) {
        result += '\n[Output truncated due to size limit]';
      }
      return result;
    },
  };
}

/**
 * Creates a tool that executes shell commands using the Wesh service.
 * The tool name and description are configurable to hide the "Wesh" name from the LLM if desired.
 */
export function createWeshTool({
  wesh,
  mounts = [],
  name = 'shell_execute',
  description,
  defaultStdoutLimit = 4096,
  defaultStderrLimit = 4096,
}: WeshToolOptions): Tool {
  // Apply mounts to the Wesh instance
  for (const mount of mounts) {
    wesh.vfs.mount({
      path: mount.path,
      handle: mount.handle,
      readOnly: mount.readOnly,
    });
  }

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

    async execute({ args, signal }: { args: unknown; signal?: AbortSignal }) {
      try {
        if (signal?.aborted) throw new Error('Generation aborted');
        const validated = WeshArgsSchema.parse(args);

        const stdoutCapture = createCaptureHandle({ limit: validated.stdout_limit });
        const stderrCapture = createCaptureHandle({ limit: validated.stderr_limit });
        const stdin = createWeshReadFileHandleFromText({ text: '' });

        const result = await wesh.execute({
          script: validated.shell_script,
          stdin,
          stdout: stdoutCapture.handle,
          stderr: stderrCapture.handle,
        });

        // Close handles
        await stdoutCapture.handle.close();
        await stderrCapture.handle.close();
        await stdin.close();

        let content = `Exit Code: ${result.exitCode}\n`;
        const stdoutText = stdoutCapture.text;
        const stderrText = stderrCapture.text;

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
      }
    },
  };
}
