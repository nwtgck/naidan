import type { WeshCommandDefinition, WeshCommandResult, WeshCommandContext } from '@/services/wesh/types';

export const headCommandDefinition: WeshCommandDefinition = {
  meta: {
    name: 'head',
    description: 'Output the first part of files',
    usage: 'head [OPTION]... [FILE]...',
  },
  fn: async ({ context }: { context: WeshCommandContext }): Promise<WeshCommandResult> => {
    const { args } = context;
    const textOutput = context.text();

    let lines = 10;
    let bytes: number | undefined;
    const positional: string[] = [];

    // Parse arguments
    for (let i = 0; i < args.length; i++) {
      const arg = args[i];

      if (arg.startsWith('-')) {
        if (arg === '--') {
          positional.push(...args.slice(i + 1));
          break;
        }

        // Handle -N (lines) or -c N (bytes) or -n N (lines)
        if (/^-\d+$/.test(arg)) {
          lines = parseInt(arg.slice(1), 10);
        } else if (arg.startsWith('-n')) {
          const val = arg.length > 2 ? arg.slice(2) : args[++i];
          if (val === undefined || isNaN(parseInt(val, 10))) {
            await textOutput.error({ text: `head: invalid number of lines: '${val}'\n` });
            return { exitCode: 1 };
          }
          lines = parseInt(val, 10);
        } else if (arg.startsWith('-c')) {
          const val = arg.length > 2 ? arg.slice(2) : args[++i];
          if (val === undefined || isNaN(parseInt(val, 10))) {
            await textOutput.error({ text: `head: invalid number of bytes: '${val}'\n` });
            return { exitCode: 1 };
          }
          bytes = parseInt(val, 10);
          lines = -1; // Bytes mode overrides lines mode
        } else {
          await textOutput.error({ text: `head: invalid option -- '${arg}'\n` });
          return { exitCode: 1 };
        }
      } else {
        positional.push(arg);
      }
    }

    const processStream = async ({ stream }: { stream: ReadableStream<Uint8Array> }) => {
      const reader = stream.getReader();
      
      if (bytes !== undefined) {
        let bytesReadCount = 0;
        while (bytesReadCount < bytes) {
          const { done, value } = await reader.read();
          if (done) break;
          
          const toRead = Math.min(value.length, bytes - bytesReadCount);
          await textOutput.print({ text: new TextDecoder().decode(value.subarray(0, toRead)) });
          bytesReadCount += toRead;
        }
      } else {
        const decoder = new TextDecoder();
        let linesProcessed = 0;
        let buffer = '';
        
        while (linesProcessed < lines) {
          const { done, value } = await reader.read();
          if (done) {
            if (buffer) await textOutput.print({ text: buffer });
            break;
          }
          
          buffer += decoder.decode(value, { stream: true });
          const parts = buffer.split('\n');
          // If the last part isn't complete, keep it in buffer
          buffer = parts.pop() || '';
          
          for (const line of parts) {
            await textOutput.print({ text: line + '\n' });
            linesProcessed++;
            if (linesProcessed >= lines) break;
          }
        }
      }
      reader.releaseLock();
    };

    if (positional.length === 0) {
      await processStream({
        stream: new ReadableStream({
          async pull(controller) {
            const buf = new Uint8Array(4096);
            const { bytesRead } = await context.stdin.read({ buffer: buf });
            if (bytesRead === 0) {
              controller.close();
              return;
            }
            controller.enqueue(buf.subarray(0, bytesRead));
          }
        })
      });
    } else {
      for (const f of positional) {
        try {
          const fullPath = f.startsWith('/') ? f : `${context.cwd}/${f}`;
          const handle = await context.kernel.open({
            path: fullPath,
            flags: { access: 'read', creation: 'never', truncate: 'preserve', append: 'preserve' }
          });
          // Simple wrapper to use the stream
          await processStream({ 
            stream: new ReadableStream({
              async pull(controller) {
                const buf = new Uint8Array(4096);
                const { bytesRead } = await handle.read({ buffer: buf });
                if (bytesRead === 0) {
                  controller.close();
                  return;
                }
                controller.enqueue(buf.subarray(0, bytesRead));
              }
            })
          });
        } catch (e: unknown) {
          const message = e instanceof Error ? e.message : String(e);
          await textOutput.error({ text: `head: ${f}: ${message}\n` });
        }
      }
    }

    return { exitCode: 0 };
  },
};
