import type { WeshCharacterLocaleMode } from '@/features/wesh/commands/_shared/locale';
import type { createBufferedCommandDataWriter } from '@/features/wesh/commands/_shared/data-codec';
import { fromSedLocaleText } from './locale-text';
import type { SedOutput, SedTextLine } from './runtime-model';

export interface SedOutputWriter {
  write({ output }: { output: SedOutput }): Promise<void>;
  terminatePendingOutput(): Promise<void>;
  writeAppendText({ text }: { text: string }): Promise<void>;
  writeReadFile({
    lines,
    terminatePendingOutputWhenEmpty,
  }: {
    lines: AsyncIterable<SedTextLine> | undefined;
    terminatePendingOutputWhenEmpty: boolean;
  }): Promise<void>;
  flush(): Promise<void>;
}


export function createSedOutputWriter({
  writer,
  recordTerminator,
  characterLocaleMode,
}: {
  writer: ReturnType<typeof createBufferedCommandDataWriter>;
  recordTerminator: string;
  characterLocaleMode: WeshCharacterLocaleMode;
}): SedOutputWriter {
  let previousOutputMissingNewline = false;
  const terminatePendingOutput = async (): Promise<void> => {
    if (!previousOutputMissingNewline) return;
    await writer.write({
      text: fromSedLocaleText({ text: recordTerminator, characterLocaleMode }),
    });
    previousOutputMissingNewline = false;
  };
  return {
    write: async ({ output }) => {
      await terminatePendingOutput();
      await writer.write({
        text: fromSedLocaleText({
          text: output.hadNewline
            ? `${output.text}${recordTerminator}`
            : output.text,
          characterLocaleMode,
        }),
      });
      previousOutputMissingNewline = !output.hadNewline;
    },
    terminatePendingOutput,
    writeAppendText: async ({ text }) => {
      await terminatePendingOutput();
      await writer.write({
        text: fromSedLocaleText({ text: `${text}\n`, characterLocaleMode }),
      });
      previousOutputMissingNewline = false;
    },
    writeReadFile: async ({ lines, terminatePendingOutputWhenEmpty }) => {
      let wroteLine = false;
      if (lines !== undefined) {
        for await (const line of lines) {
          if (!wroteLine && previousOutputMissingNewline) {
            await writer.write({
              text: fromSedLocaleText({ text: recordTerminator, characterLocaleMode }),
            });
          }
          await writer.write({
            text: fromSedLocaleText({
              text: line.hadNewline
                ? `${line.line}${recordTerminator}`
                : line.line,
              characterLocaleMode,
            }),
          });
          wroteLine = true;
        }
      }
      if (
        !wroteLine &&
        terminatePendingOutputWhenEmpty &&
        previousOutputMissingNewline
      ) {
        await writer.write({ text: recordTerminator });
      }
      if (wroteLine || terminatePendingOutputWhenEmpty) {
        previousOutputMissingNewline = false;
      }
    },
    flush: async () => {
      await writer.flush();
    },
  };
}


export const TEST_ONLY = {
};
