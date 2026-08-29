export const ModelSupportInvestigationModal__tool_template_provenance_summary = ({ mode, suffixTokenCount, firstMismatchIndex, reason }: { mode: 'prefix' | 'difference' | 'unavailable'; suffixTokenCount: number | undefined; firstMismatchIndex: number | undefined; reason: string | undefined }): string => {
  switch (mode) {
  case 'prefix':
    return `도구 템플릿 출처: 해석된 토크나이저 출력에서 assistant 도구 호출 접미부 토큰 ${suffixTokenCount ?? 0}개를 분리했습니다.`;
  case 'difference':
    return `도구 템플릿 출처: 렌더링된 토큰 시퀀스가 ${firstMismatchIndex ?? '길이 경계'}에서 처음 달라집니다. 접미부는 추론하지 않았습니다.`;
  case 'unavailable':
    return `도구 템플릿 출처를 확인할 수 없음: ${reason ?? '필요한 템플릿 사례가 관측되지 않음'}`;
  default: {
    const _ex: never = mode;
    return _ex;
  }
  }
};
