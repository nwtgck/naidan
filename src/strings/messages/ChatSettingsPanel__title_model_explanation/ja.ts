type TitleModelInheritance =
  | { readonly type: 'none' }
  | {
    readonly type: 'inherited',
    readonly state: 'enabled' | 'disabled',
    readonly source: 'chat' | 'chat_group' | 'global',
  };

export const ChatSettingsPanel__title_model_explanation = ({ inheritance }: { inheritance: TitleModelInheritance }): string => {
  const description = 'タイトルモデルは、最初のユーザーメッセージを一度だけ要約するために使われます。';
  switch (inheritance.type) {
  case 'none':
    return description;
  case 'inherited': {
    const state = (() => {
      switch (inheritance.state) {
      case 'enabled':
        return '有効';
      case 'disabled':
        return '無効';
      default: {
        const _ex: never = inheritance.state;
        throw new Error(`Unhandled title model state: ${_ex}`);
      }
      }
    })();
    switch (inheritance.source) {
    case 'chat':
      return `${description}現在はチャット設定の「${state}」を継承しています。`;
    case 'chat_group':
      return `${description}現在はグループ設定の「${state}」を継承しています。`;
    case 'global':
      return `${description}現在はグローバル設定の「${state}」を継承しています。`;
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
