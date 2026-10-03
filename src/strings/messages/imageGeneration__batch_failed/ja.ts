export const imageGeneration__batch_failed = ({ succeeded, failed }: { succeeded: number; failed: number }): string => `${succeeded}件を完了し、${failed}件が失敗しました。完了した変更は保存されています。再読込後に再試行してください。`;
