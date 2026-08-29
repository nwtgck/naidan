export const ChatGroupSettingsPanel__title_model_explanation = ({ inheritance }: { inheritance: 'none' | 'enabled' | 'disabled' }): string => {
  const description = '标题模型用于概括新聊天中的第一条用户消息。';
  switch (inheritance) {
  case 'none':
    return description;
  case 'enabled':
    return `${description} 当前从全局设置继承“启用”。`;
  case 'disabled':
    return `${description} 当前从全局设置继承“禁用”。`;
  default: {
    const _ex: never = inheritance;
    throw new Error(`Unhandled title model inheritance: ${_ex}`);
  }
  }
};
