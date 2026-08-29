export const SettingsModal__successfully_imported_recipes_as_chat_groups = ({ recipeCount }: { recipeCount: number }): string => recipeCount === 1
  ? '1 receita foi importada com sucesso como grupo de conversas'
  : `${recipeCount} receitas foram importadas com sucesso como grupos de conversas`;
