export const StandaloneVerificationPage__verification_summary = ({ status, passed, failed }: { status: string; passed: number; failed: number }): string => (
  `${status} — ${passed}개 통과 / ${failed}개 실패`
);
