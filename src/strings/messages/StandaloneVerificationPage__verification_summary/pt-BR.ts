export const StandaloneVerificationPage__verification_summary = ({ status, passed, failed }: { status: string; passed: number; failed: number }): string => (
  `${status} — ${passed} ${passed === 1 ? 'aprovada' : 'aprovadas'} / ${failed} ${failed === 1 ? 'falhou' : 'falharam'}`
);
