export const ModelSupportInvestigationSession__feature_check_result = ({ kind, outcome, context }: { kind: 'first-turn' | 'continuity' | 'tool-result' | 'reasoning' | 'multimodal' | 'template' | 'reference-load' | 'input-strategy' | 'natural-generation' | 'tool-probe' | 'tool-parser' | 'tool-template' | 'stage'; outcome: 'passed' | 'failed' | 'observed' | 'blocked' | 'not-run' | 'not-selected' | 'not-recorded' | 'unavailable'; context: string }): string => {
  const features = {
    "first-turn": "初回の生成",
    "continuity": "会話の継続",
    "tool-result": "ツール結果からの会話継続",
    "reasoning": "推論",
    "multimodal": "画像入力",
    "template": "チャットテンプレート",
    "reference-load": "Reference の読み込み",
    "input-strategy": "入力方式",
    "natural-generation": "自然な生成",
    "tool-probe": "強制したツール形式",
    "tool-parser": "ツールの解析",
    "tool-template": "ツール結果のテンプレート",
    "stage": "調査工程"
  };
  const outcomes = {
    "passed": "実行成功",
    "failed": "失敗",
    "observed": "観測のみ",
    "blocked": "実行できず",
    "not-run": "未実行",
    "not-selected": "未選択",
    "not-recorded": "未記録",
    "unavailable": "利用不可"
  };
  return `${features[kind]} · ${outcomes[outcome]} (${context})`;
};
