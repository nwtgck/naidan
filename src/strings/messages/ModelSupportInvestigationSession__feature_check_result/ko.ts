export const ModelSupportInvestigationSession__feature_check_result = ({ kind, outcome, context }: { kind: 'first-turn' | 'continuity' | 'tool-result' | 'reasoning' | 'multimodal' | 'template' | 'reference-load' | 'input-strategy' | 'natural-generation' | 'tool-probe' | 'tool-parser' | 'tool-template' | 'stage'; outcome: 'passed' | 'failed' | 'observed' | 'blocked' | 'not-run' | 'not-selected' | 'not-recorded' | 'unavailable'; context: string }): string => {
  const features = {
    "first-turn": "첫 응답 생성",
    "continuity": "대화 연속성",
    "tool-result": "도구 결과 이후 대화",
    "reasoning": "추론",
    "multimodal": "이미지 입력",
    "template": "채팅 템플릿",
    "reference-load": "Reference 로드",
    "input-strategy": "입력 방식",
    "natural-generation": "자연 생성",
    "tool-probe": "강제 도구 형식",
    "tool-parser": "도구 파서",
    "tool-template": "도구 결과 템플릿",
    "stage": "조사 단계"
  };
  const outcomes = {
    "passed": "실행 성공",
    "failed": "실패",
    "observed": "관측만 완료",
    "blocked": "차단됨",
    "not-run": "미실행",
    "not-selected": "선택 안 함",
    "not-recorded": "기록 없음",
    "unavailable": "사용 불가"
  };
  return `${features[kind]} · ${outcomes[outcome]} (${context})`;
};
