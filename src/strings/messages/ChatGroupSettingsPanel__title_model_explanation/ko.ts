export const ChatGroupSettingsPanel__title_model_explanation = ({ inheritance }: { inheritance: 'none' | 'enabled' | 'disabled' }): string => {
  const description = '제목 모델은 새 채팅의 첫 번째 사용자 메시지를 요약하는 데 사용됩니다.';
  switch (inheritance) {
  case 'none':
    return description;
  case 'enabled':
    return `${description} 현재 전역 설정에서 “활성화”를 상속하고 있습니다.`;
  case 'disabled':
    return `${description} 현재 전역 설정에서 “비활성화”를 상속하고 있습니다.`;
  default: {
    const _ex: never = inheritance;
    throw new Error(`Unhandled title model inheritance: ${_ex}`);
  }
  }
};
