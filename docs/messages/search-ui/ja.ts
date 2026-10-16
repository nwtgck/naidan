export const messages = {
  search_ui_open_search: 'ドキュメントを検索',
  search_ui_close_search: '検索を閉じる',
  search_ui_title: 'ガイドを検索',
  search_ui_placeholder: 'やりたいことや機能を入力',
  search_ui_purpose_title: '目的から探す',
  search_ui_loading: 'ガイドを検索しています…',
  search_ui_no_results: '一致するガイドはありません。',
  search_ui_result_count: ({ count }: { count: number }): string => `${count}件`,
  search_ui_previous_results: ({ query }: { query: string }): string => `「${query}」の前の検索結果を表示中`,
  search_ui_error: 'ガイドを読み込めませんでした。もう一度お試しください。',
  search_ui_retry: '再試行',
} satisfies typeof import('./en').messages;
