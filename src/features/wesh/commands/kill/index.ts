import { isStandaloneCommandHelpRequest, writeCommandHelp } from '@/features/wesh/commands/_shared/usage';
import { uppercaseAscii } from '@/features/wesh/commands/_shared/locale';
import { stripLeadingCLocaleAndTrailingBlankWhitespace } from '@/features/wesh/commands/_shared/numeric-whitespace';
import {
  formatLinuxSignalList,
  linuxSignalByName,
  linuxSignalByNumber,
  parseLinuxSignal,
} from '@/features/wesh/commands/_shared/linux-signals';
import type { WeshCommandContext, WeshCommandImplementation, WeshCommandResult } from '@/features/wesh/types';

type KillParseResult =
  | { kind: 'list', values: string[] }
  | { kind: 'run', signal: number, targets: string[] }
  | { kind: 'error', exitCode: 1 | 2, message: string };

function parseKillArguments({ args }: { args: string[] }): KillParseResult {
  let signal = 15;
  let listSignals = false;
  let index = 0;

  while (index < args.length) {
    const argument = args[index];
    if (argument === undefined) break;
    if (argument === '--') {
      index += 1;
      break;
    }
    if (argument === '-l' || argument === '-L' || argument === '--list') {
      listSignals = true;
      index += 1;
      continue;
    }
    if (argument === '-s' || argument === '--signal' || argument === '-n') {
      const value = args[index + 1];
      if (value === undefined) {
        return {
          kind: 'error',
          exitCode: 1,
          message: `kill: ${argument}: option requires an argument`,
        };
      }
      const parsed = parseLinuxSignal({ value, allowZero: true });
      if (parsed === undefined) {
        return {
          kind: 'error',
          exitCode: 1,
          message: `kill: ${value}: invalid signal specification`,
        };
      }
      signal = parsed;
      index += 2;
      continue;
    }
    if (argument.startsWith('-') && argument.length > 1) {
      const parsed = parseLinuxSignal({ value: argument.slice(1), allowZero: true });
      if (parsed === undefined) {
        return {
          kind: 'error',
          exitCode: 1,
          message: `kill: ${argument.slice(1)}: invalid signal specification`,
        };
      }
      signal = parsed;
      index += 1;
      continue;
    }
    break;
  }

  const targets = args.slice(index);
  if (listSignals) {
    return { kind: 'list', values: targets };
  }
  if (targets.length === 0) {
    return {
      kind: 'error',
      exitCode: 2,
      message: 'kill: usage: kill -l [sigspec ...] | kill [-s sigspec | -n signum | -sigspec] pid ...',
    };
  }
  return { kind: 'run', signal, targets };
}

function parseNumericTarget({ value }: { value: string }): number | undefined {
  const numericText = stripLeadingCLocaleAndTrailingBlankWhitespace({ value });
  if (!/^[+-]?\d+$/u.test(numericText)) return undefined;

  const parsed = Number(numericText);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

function formatListedSignal({ value }: { value: string }): string | undefined {
  const numericText = stripLeadingCLocaleAndTrailingBlankWhitespace({ value });
  if (/^\+?\d+$/u.test(numericText)) {
    const rawNumber = Number.parseInt(numericText, 10);
    if (rawNumber === 0) return 'EXIT';
    const number = rawNumber > 128 ? rawNumber - 128 : rawNumber;
    if (number === 32 || number === 33) return '';
    return linuxSignalByNumber({ number })?.name.slice(3);
  }
  const signalName = uppercaseAscii({ value });
  if (signalName === 'EXIT') return '0';
  return linuxSignalByName({ name: signalName })?.number.toString();
}

export const killCommandImplementation: WeshCommandImplementation = {
  fn: async ({ context }: { context: WeshCommandContext }): Promise<WeshCommandResult> => {
    if (isStandaloneCommandHelpRequest({ args: context.args, acceptedForms: [['--help']] })) {
      await writeCommandHelp({ context, command: 'kill' });
      return { exitCode: 0 };
    }
    const parsed = parseKillArguments({ args: context.args });
    switch (parsed.kind) {
    case 'error':
      await context.text().error({ text: `${parsed.message}\n` });
      return { exitCode: parsed.exitCode };
    case 'list': {
      if (parsed.values.length === 0) {
        await context.text().print({ text: formatLinuxSignalList() });
        return { exitCode: 0 };
      }
      let exitCode: 0 | 1 = 0;
      for (const value of parsed.values) {
        const formatted = formatListedSignal({ value });
        if (formatted === undefined) {
          await context.text().error({ text: `kill: ${value}: invalid signal specification\n` });
          exitCode = 1;
          continue;
        }
        if (formatted.length !== 0) {
          await context.text().print({ text: `${formatted}\n` });
        }
      }
      return { exitCode };
    }
    case 'run':
      break;
    default: {
      const _ex: never = parsed;
      throw new Error(`Unhandled kill parse result: ${JSON.stringify(_ex)}`);
    }
    }

    const processes = context.getProcesses();
    const ownPid = context.process.getPid();
    const ownGroupId = context.process.getGroupId();
    let hadSuccessfulTarget = false;
    let hadFailedTarget = false;

    for (const target of parsed.targets) {
      if (target.startsWith('%')) {
        await context.text().error({
          text: `kill: ${target}: job signaling requires Wesh core job process-group support\n`,
        });
        hadFailedTarget = true;
        continue;
      }

      const numericTarget = parseNumericTarget({ value: target });
      if (numericTarget !== undefined && numericTarget < 0) {
        const pgid = Math.abs(numericTarget);
        const exists = processes.some(process => process.pgid === pgid);
        if (!exists) {
          await context.text().error({ text: `kill: ${target}: no such process or job\n` });
          hadFailedTarget = true;
          continue;
        }
        if (parsed.signal === 0) {
          hadSuccessfulTarget = true;
          continue;
        }
        if (pgid !== ownGroupId) {
          await context.text().error({
            text: `kill: ${target}: signaling another process group requires Wesh core process-table mutation support\n`,
          });
          hadFailedTarget = true;
          continue;
        }
        await context.process.signalGroup({ signal: parsed.signal });
        hadSuccessfulTarget = true;
        continue;
      }

      if (numericTarget === 0) {
        if (parsed.signal !== 0) {
          await context.process.signalGroup({ signal: parsed.signal });
        }
        hadSuccessfulTarget = true;
        continue;
      }

      const pid = numericTarget !== undefined && numericTarget > 0 ? numericTarget : undefined;
      const exists = pid !== undefined && processes.some(process => process.pid === pid);
      if (!exists) {
        await context.text().error({ text: `kill: ${target}: no such process or job\n` });
        hadFailedTarget = true;
        continue;
      }
      if (parsed.signal === 0) {
        hadSuccessfulTarget = true;
        continue;
      }
      if (pid !== ownPid) {
        await context.text().error({
          text: `kill: ${target}: signaling another process requires Wesh core process-table mutation support\n`,
        });
        hadFailedTarget = true;
        continue;
      }
      await context.process.signalSelf({ signal: parsed.signal });
      hadSuccessfulTarget = true;
    }
    return { exitCode: hadSuccessfulTarget || !hadFailedTarget ? 0 : 1 };
  },
};

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
  formatListedSignal,
  parseKillArguments,
};
