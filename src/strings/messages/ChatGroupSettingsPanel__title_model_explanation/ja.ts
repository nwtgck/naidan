export const ChatGroupSettingsPanel__title_model_explanation = ({ inheritance }: { inheritance: 'none' | 'enabled' | 'disabled' }): string => {
  const description = 'タイトルモデルは、新しいチャットの最初のユーザーメッセージを要約します。';
  switch (inheritance) {
  case 'none':
    return description;
  case 'enabled':
    return `${description}現在はグローバル設定の「有効」を継承しています。`;
  case 'disabled':
    return `${description}現在はグローバル設定の「無効」を継承しています。`;
  default: {
    const _ex: never = inheritance;
    throw new Error(`Unhandled title model inheritance: ${_ex}`);
  }
  }
};
