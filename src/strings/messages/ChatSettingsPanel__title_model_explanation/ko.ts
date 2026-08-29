type TitleModelInheritance =
  | { readonly type: 'none' }
  | {
    readonly type: 'inherited',
    readonly state: 'enabled' | 'disabled',
    readonly source: 'chat' | 'chat_group' | 'global',
  };

export const ChatSettingsPanel__title_model_explanation = ({ inheritance }: { inheritance: TitleModelInheritance }): string => {
  const description = '제목 모델은 첫 번째 사용자 메시지를 한 번만 요약하는 데 사용됩니다.';

  switch (inheritance.type) {
  case 'none':
    return description;
  case 'inherited': {
    const state = (() => {
      switch (inheritance.state) {
      case 'enabled':
        return '활성';
      case 'disabled':
        return '비활성';
      default: {
        const _ex: never = inheritance.state;
        throw new Error(`Unhandled title model state: ${_ex}`);
      }
      }
    })();

    switch (inheritance.source) {
    case 'chat':
      return `${description} 현재 채팅 설정의 “${state}” 상태를 상속합니다.`;
    case 'chat_group':
      return `${description} 현재 그룹 설정의 “${state}” 상태를 상속합니다.`;
    case 'global':
      return `${description} 현재 전역 설정의 “${state}” 상태를 상속합니다.`;
    default: {
      const _ex: never = inheritance.source;
      throw new Error(`Unhandled settings source: ${_ex}`);
    }
    }
  }
  default: {
    const _ex: never = inheritance;
    throw new Error(`Unhandled title model inheritance: ${JSON.stringify(_ex)}`);
  }
  }
};
