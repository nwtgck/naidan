type TitleModelInheritance =
  | { readonly type: 'none' }
  | {
    readonly type: 'inherited',
    readonly state: 'enabled' | 'disabled',
    readonly source: 'chat' | 'chat_group' | 'global',
  };

export const ChatSettingsPanel__title_model_explanation = ({ inheritance }: { inheritance: TitleModelInheritance }): string => {
  const description = 'O modelo de título é usado apenas uma vez para resumir a primeira mensagem do usuário.';

  switch (inheritance.type) {
  case 'none':
    return description;
  case 'inherited': {
    const state = (() => {
      switch (inheritance.state) {
      case 'enabled':
        return 'Ativado';
      case 'disabled':
        return 'Desativado';
      default: {
        const _ex: never = inheritance.state;
        throw new Error(`Unhandled title model state: ${_ex}`);
      }
      }
    })();

    switch (inheritance.source) {
    case 'chat':
      return `${description} Atualmente herda “${state}” de Configurações do Chat.`;
    case 'chat_group':
      return `${description} Atualmente herda “${state}” de Configurações do Grupo.`;
    case 'global':
      return `${description} Atualmente herda “${state}” de Configurações Globais.`;
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
