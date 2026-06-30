export const StandaloneVerificationPage__verification_summary = ({ status, passed, failed }: { status: string; passed: number; failed: number }): string => (
  `${status} — 成功 ${passed} 件 / 失敗 ${failed} 件`
);
