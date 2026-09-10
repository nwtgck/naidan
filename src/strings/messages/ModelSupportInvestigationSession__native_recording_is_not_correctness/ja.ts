export const ModelSupportInvestigationSession__native_recording_is_not_correctness = ({ recording }: { recording: 'not-recorded' | 'partial' | 'recorded' }): string => {
  const labels = {"not-recorded":"保持された記録なし","partial":"不足のある記録","recorded":"収集範囲内で追加の不足は検出されていません"};
  return `内部処理の記録：${labels[recording]}。記録の取得や生成要求の終了は、回答の正しさや完全な再現を保証しません。`;
};
