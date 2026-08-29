export const StandaloneVerificationPage__verification_summary = ({ status, passed, failed }: { status: string; passed: number; failed: number }): string => (
  `${status} — ${passed} ${passed === 1 ? 'superada' : 'superadas'} / ${failed} ${failed === 1 ? 'fallida' : 'fallidas'}`
);
