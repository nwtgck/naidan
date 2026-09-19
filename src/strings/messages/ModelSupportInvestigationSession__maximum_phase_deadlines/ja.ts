export const ModelSupportInvestigationSession__maximum_phase_deadlines = ({ runSeconds, collectionSeconds, sealingSeconds, cleanupSeconds }: { runSeconds: number; collectionSeconds: number; sealingSeconds: number; cleanupSeconds: number }): string => (
  `最大待機時間：生成要求 ${runSeconds} 秒、記録の収集 ${collectionSeconds} 秒、資料作成 ${sealingSeconds} 秒、終了処理 ${cleanupSeconds} 秒。通常の所要時間ではなく、安全のための上限です。`
);
