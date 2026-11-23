export {
  resolveBackupControl,
  selectBackup,
  selectBackupSuffix,
  type BackupControl,
} from '@/features/wesh/commands/_shared/backup-domain';

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
