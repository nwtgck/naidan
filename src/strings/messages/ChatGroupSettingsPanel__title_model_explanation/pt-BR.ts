export const ChatGroupSettingsPanel__title_model_explanation = ({ inheritance }: { inheritance: 'none' | 'enabled' | 'disabled' }): string => {
  const description = 'O modelo de título é usado para resumir a primeira mensagem do usuário em novos chats.';
  switch (inheritance) {
  case 'none':
    return description;
  case 'enabled':
    return `${description} Atualmente herda Ativado das configurações globais.`;
  case 'disabled':
    return `${description} Atualmente herda Desativado das configurações globais.`;
  default: {
    const _ex: never = inheritance;
    throw new Error(`Unhandled title model inheritance: ${_ex}`);
  }
  }
};
