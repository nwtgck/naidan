export const messages = {
  search_ui_open_search: 'Search docs',
  search_ui_close_search: 'Close search',
  search_ui_title: 'Search guides',
  search_ui_placeholder: 'Search for a task or feature',
  search_ui_purpose_title: 'Explore by goal',
  search_ui_loading: 'Searching guides…',
  search_ui_no_results: 'No guides match your search.',
  search_ui_result_count: ({ count }: { count: number }): string => `${count} ${count === 1 ? 'result' : 'results'}`,
  search_ui_previous_results: ({ query }: { query: string }): string => `Showing previous results for “${query}”`,
  search_ui_error: 'Could not load the guide index. Try again.',
  search_ui_retry: 'Try again',
};
