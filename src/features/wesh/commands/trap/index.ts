import { uppercaseAscii } from '@/features/wesh/commands/_shared/locale';
import { isStandaloneCommandHelpRequest, writeCommandHelp } from '@/features/wesh/commands/_shared/usage';
import type {
  WeshCommandContext,
  WeshCommandDefinition,
  WeshCommandResult,
  WeshTrapDisposition,
} from '@/features/wesh/types';

import {
  formatLinuxSignalList,
  LINUX_SIGNAL_DEFINITIONS,
  parseLinuxSignal,
  linuxSignalByNumber,
} from '@/features/wesh/commands/_shared/linux-signals';

const PSEUDO_TRAP_CONDITIONS = new Set(['DEBUG', 'ERR', 'RETURN']);

function normalizeTrapCondition({ value }: { value: string }): string | undefined {
  const upper = uppercaseAscii({ value });
  if (upper === 'EXIT') {
    return 'EXIT';
  }
  if (PSEUDO_TRAP_CONDITIONS.has(upper)) {
    return upper;
  }

  const signal = parseLinuxSignal({ value, allowZero: true });
  if (signal === 0) return 'EXIT';
  return signal === undefined ? undefined : linuxSignalByNumber({ number: signal })?.name;
}

function trapConditionOrder({ condition }: { condition: string }): number {
  if (condition === 'EXIT') return 0;
  if (condition === 'DEBUG') return 65;
  if (condition === 'ERR') return 66;
  if (condition === 'RETURN') return 67;
  if (/^\d+$/u.test(condition)) return Number.parseInt(condition, 10);
  const definition = LINUX_SIGNAL_DEFINITIONS.find(candidate => candidate.name === condition);
  return definition?.number ?? Number.MAX_SAFE_INTEGER;
}

function shellQuote({ text }: { text: string }): string {
  return `'${text.replaceAll('\'', `'\\''`)}'`;
}

function formatTrap({
  condition,
  disposition,
}: {
  condition: string,
  disposition: WeshTrapDisposition,
}): string {
  switch (disposition.kind) {
  case 'ignore':
    return `trap -- '' ${condition}\n`;
  case 'run':
    return `trap -- ${shellQuote({ text: disposition.action })} ${condition}\n`;
  default: {
    const _ex: never = disposition;
    throw new Error(`Unhandled trap disposition: ${JSON.stringify(_ex)}`);
  }
  }
}

async function writeTrapUsage({ context }: { context: WeshCommandContext }): Promise<void> {
  await context.text().error({ text: 'trap: usage: trap [-lp] [[arg] signal_spec ...]\n' });
}

async function writeInvalidCondition({
  context,
  condition,
}: {
  context: WeshCommandContext,
  condition: string,
}): Promise<void> {
  await context.text().error({ text: `trap: ${condition}: invalid signal specification\n` });
}

export const trapCommandDefinition: WeshCommandDefinition = {
  meta: {
    name: 'trap',
    description: 'Set shell trap handlers',
    usage: 'trap [-lp] [[arg] signal_spec ...]',
  },
  fn: async ({ context }: { context: WeshCommandContext }): Promise<WeshCommandResult> => {
    if (isStandaloneCommandHelpRequest({
      args: context.args,
      acceptedForms: [['--help']],
    })) {
      await writeCommandHelp({ context, command: 'trap' });
      return { exitCode: 0 };
    }

    let print = false;
    let list = false;
    let index = 0;
    while (index < context.args.length) {
      const argument = context.args[index];
      if (argument === undefined) break;
      if (argument === '--') {
        index += 1;
        break;
      }
      if (argument === '-' || !argument.startsWith('-')) {
        break;
      }
      if (!/^-+[lp]+$/u.test(argument)) {
        await context.text().error({ text: `trap: ${argument}: invalid option\n` });
        await writeTrapUsage({ context });
        return { exitCode: 2 };
      }
      for (const option of argument.slice(1)) {
        if (option === 'p') print = true;
        if (option === 'l') list = true;
      }
      index += 1;
    }

    const positionals = context.args.slice(index);
    if (list) {
      await context.text().print({ text: formatLinuxSignalList() });
      return { exitCode: 0 };
    }

    const printConditions = async ({ values }: { values: readonly string[] }): Promise<number> => {
      const traps = new Map(context.getTraps());
      const conditions: string[] = [];
      let exitCode = 0;
      if (values.length === 0) {
        conditions.push(
          ...Array.from(traps.keys()).sort((left, right) => (
            trapConditionOrder({ condition: left }) - trapConditionOrder({ condition: right })
          )),
        );
      } else {
        for (const value of values) {
          const condition = normalizeTrapCondition({ value });
          if (condition === undefined) {
            await writeInvalidCondition({ context, condition: value });
            exitCode = 1;
            continue;
          }
          conditions.push(condition);
        }
      }
      for (const condition of conditions) {
        const disposition = traps.get(condition);
        if (disposition !== undefined) {
          await context.text().print({ text: formatTrap({ condition, disposition }) });
        }
      }
      return exitCode;
    };

    if (print || positionals.length === 0) {
      return { exitCode: await printConditions({ values: positionals }) };
    }

    if (positionals.length < 2) {
      await writeTrapUsage({ context });
      return { exitCode: 2 };
    }

    const action = positionals[0] ?? '';
    let exitCode = 0;
    for (const value of positionals.slice(1)) {
      const condition = normalizeTrapCondition({ value });
      if (condition === undefined) {
        await writeInvalidCondition({ context, condition: value });
        exitCode = 1;
        continue;
      }
      const disposition: WeshTrapDisposition | undefined = (() => {
        switch (action) {
        case '-':
          return undefined;
        case '':
          return { kind: 'ignore' };
        default:
          return { kind: 'run', action };
        }
      })();
      context.setTrap({ condition, disposition });
    }
    return { exitCode };
  },
};

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
  formatLinuxSignalList,
  normalizeTrapCondition,
  trapConditionOrder,
};
