type TitleModelInheritance =
  | { readonly type: 'none' }
  | {
    readonly type: 'inherited',
    readonly state: 'enabled' | 'disabled',
    readonly source: 'chat' | 'chat_group' | 'global',
  };

export const ChatSettingsPanel__title_model_explanation = ({ inheritance }: { inheritance: TitleModelInheritance }): string => {
  const description = 'The title model is used only once to summarize the first user message.';
  switch (inheritance.type) {
  case 'none':
    return description;
  case 'inherited': {
    const state = (() => {
      switch (inheritance.state) {
      case 'enabled':
        return 'Enabled';
      case 'disabled':
        return 'Disabled';
      default: {
        const _ex: never = inheritance.state;
        throw new Error(`Unhandled title model state: ${_ex}`);
      }
      }
    })();
    switch (inheritance.source) {
    case 'chat':
      return `${description} Currently inheriting ${state} from Chat Settings.`;
    case 'chat_group':
      return `${description} Currently inheriting ${state} from Group Settings.`;
    case 'global':
      return `${description} Currently inheriting ${state} from Global Settings.`;
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
