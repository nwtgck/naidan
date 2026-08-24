import { stripLeadingCLocaleAndTrailingBlankWhitespace } from '@/features/wesh/commands/_shared/numeric-whitespace';
import { uppercaseAscii } from '@/features/wesh/commands/_shared/locale';

export interface LinuxSignalDefinition {
  readonly number: number,
  readonly name: string,
}

export const LINUX_SIGNAL_DEFINITIONS: readonly LinuxSignalDefinition[] = [
  { number: 1, name: 'SIGHUP' },
  { number: 2, name: 'SIGINT' },
  { number: 3, name: 'SIGQUIT' },
  { number: 4, name: 'SIGILL' },
  { number: 5, name: 'SIGTRAP' },
  { number: 6, name: 'SIGABRT' },
  { number: 7, name: 'SIGBUS' },
  { number: 8, name: 'SIGFPE' },
  { number: 9, name: 'SIGKILL' },
  { number: 10, name: 'SIGUSR1' },
  { number: 11, name: 'SIGSEGV' },
  { number: 12, name: 'SIGUSR2' },
  { number: 13, name: 'SIGPIPE' },
  { number: 14, name: 'SIGALRM' },
  { number: 15, name: 'SIGTERM' },
  { number: 16, name: 'SIGSTKFLT' },
  { number: 17, name: 'SIGCHLD' },
  { number: 18, name: 'SIGCONT' },
  { number: 19, name: 'SIGSTOP' },
  { number: 20, name: 'SIGTSTP' },
  { number: 21, name: 'SIGTTIN' },
  { number: 22, name: 'SIGTTOU' },
  { number: 23, name: 'SIGURG' },
  { number: 24, name: 'SIGXCPU' },
  { number: 25, name: 'SIGXFSZ' },
  { number: 26, name: 'SIGVTALRM' },
  { number: 27, name: 'SIGPROF' },
  { number: 28, name: 'SIGWINCH' },
  { number: 29, name: 'SIGIO' },
  { number: 30, name: 'SIGPWR' },
  { number: 31, name: 'SIGSYS' },
  { number: 34, name: 'SIGRTMIN' },
  { number: 35, name: 'SIGRTMIN+1' },
  { number: 36, name: 'SIGRTMIN+2' },
  { number: 37, name: 'SIGRTMIN+3' },
  { number: 38, name: 'SIGRTMIN+4' },
  { number: 39, name: 'SIGRTMIN+5' },
  { number: 40, name: 'SIGRTMIN+6' },
  { number: 41, name: 'SIGRTMIN+7' },
  { number: 42, name: 'SIGRTMIN+8' },
  { number: 43, name: 'SIGRTMIN+9' },
  { number: 44, name: 'SIGRTMIN+10' },
  { number: 45, name: 'SIGRTMIN+11' },
  { number: 46, name: 'SIGRTMIN+12' },
  { number: 47, name: 'SIGRTMIN+13' },
  { number: 48, name: 'SIGRTMIN+14' },
  { number: 49, name: 'SIGRTMIN+15' },
  { number: 50, name: 'SIGRTMAX-14' },
  { number: 51, name: 'SIGRTMAX-13' },
  { number: 52, name: 'SIGRTMAX-12' },
  { number: 53, name: 'SIGRTMAX-11' },
  { number: 54, name: 'SIGRTMAX-10' },
  { number: 55, name: 'SIGRTMAX-9' },
  { number: 56, name: 'SIGRTMAX-8' },
  { number: 57, name: 'SIGRTMAX-7' },
  { number: 58, name: 'SIGRTMAX-6' },
  { number: 59, name: 'SIGRTMAX-5' },
  { number: 60, name: 'SIGRTMAX-4' },
  { number: 61, name: 'SIGRTMAX-3' },
  { number: 62, name: 'SIGRTMAX-2' },
  { number: 63, name: 'SIGRTMAX-1' },
  { number: 64, name: 'SIGRTMAX' },
];

const SIGNAL_BY_NUMBER = new Map(
  LINUX_SIGNAL_DEFINITIONS.map(definition => [definition.number, definition]),
);
const SIGNAL_BY_NAME = new Map(
  LINUX_SIGNAL_DEFINITIONS.flatMap(definition => [
    [definition.name, definition] as const,
    [definition.name.slice(3), definition] as const,
  ]),
);


export function linuxSignalByNumber({ number }: { number: number }): LinuxSignalDefinition | undefined {
  return SIGNAL_BY_NUMBER.get(number);
}

export function linuxSignalByName({ name }: { name: string }): LinuxSignalDefinition | undefined {
  return SIGNAL_BY_NAME.get(uppercaseAscii({ value: name }));
}

export function parseLinuxSignal({
  value,
  allowZero,
}: {
  value: string,
  allowZero: boolean,
}): number | undefined {
  const numericText = stripLeadingCLocaleAndTrailingBlankWhitespace({ value });
  if (/^\+?\d+$/u.test(numericText)) {
    const number = Number.parseInt(numericText, 10);
    if (allowZero && number === 0) return 0;
    return number >= 1 && number <= 64 ? number : undefined;
  }
  return linuxSignalByName({ name: uppercaseAscii({ value }) })?.number;
}

export function formatLinuxSignalList(): string {
  const lines: string[] = [];
  for (let index = 0; index < LINUX_SIGNAL_DEFINITIONS.length; index += 5) {
    const definitions = LINUX_SIGNAL_DEFINITIONS.slice(index, index + 5);
    const line = definitions
      .map(({ number, name }) => `${number.toString().padStart(2, ' ')}) ${name}`)
      .join('\t');
    lines.push(definitions.length < 5 ? `${line}\t` : line);
  }
  return `${lines.join('\n')}\n`;
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
