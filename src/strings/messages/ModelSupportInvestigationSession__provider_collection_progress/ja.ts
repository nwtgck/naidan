export const ModelSupportInvestigationSession__provider_collection_progress = ({ phase, settled, total, active }: { phase: 'not-started' | 'loading' | 'running' | 'collecting' | 'sealing' | 'cleanup' | 'seal-release' | 'finished'; settled: number; total: number; active: string | undefined }): string => {
  const labels = {"not-started":"準備中","loading":"ローカルモデルを読み込み中","running":"固定の生成要求を実行中","collecting":"内部処理の記録を収集中","sealing":"調査資料を作成中","cleanup":"ワーカーの終了処理を待機中","seal-release":"記録の保持が解放されるまで待機中","finished":"収集終了"};
  return `${labels[phase]} · ${total} 件中 ${settled} 件の要求が終了${active === undefined ? "" : ` · ${active}`}`;
};
