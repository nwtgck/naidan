import type { ArgvSpecialParseResult } from '@/features/wesh/argv';

export {
  resolveBackupControl,
  selectBackupSuffix,
  type BackupControl,
} from '@/features/wesh/commands/_shared/backup-domain';

export function parseBackupControlLongOption({
  token,
}: {
  token: string,
}): ArgvSpecialParseResult | undefined {
  const prefix = '--backup=';
  if (!token.startsWith(prefix)) return undefined;

  const rawValue = token.slice(prefix.length);
  const effects = [
    { key: 'backup', value: true },
    { key: 'backupControlRaw', value: rawValue },
  ];
  return {
    kind: 'matched',
    consumeCount: 1,
    effects,
    occurrences: [{
      kind: 'special',
      option: '--backup',
      effects,
    }],
  };
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
