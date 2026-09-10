export const ModelSupportInvestigationSession__maximum_phase_deadlines = ({ runSeconds, collectionSeconds, sealingSeconds, cleanupSeconds }: { runSeconds: number; collectionSeconds: number; sealingSeconds: number; cleanupSeconds: number }): string => (
  `最长等待时间：请求 ${runSeconds} 秒；收集 ${collectionSeconds} 秒；证据准备 ${sealingSeconds} 秒；清理 ${cleanupSeconds} 秒。这些是安全上限，并非预期耗时。`
);
