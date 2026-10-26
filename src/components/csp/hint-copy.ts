import { lazyStrings } from '@/strings';
import type { CspHintDetail, CspHintMessage, CspHintTarget, CspSourceDescription } from '@/logic/csp-message-hints/types';
import type { CspHintActivityForDisplayOnly } from './types';

export type CspHintDisplayRow = Readonly<{
  directive: string,
  context: string,
  sourceLabels: readonly string[],
  serializedSources: string,
}>;

export type CspHintDisplayCopy = Readonly<{
  summary: string,
  title: string,
  explanation: string,
  destinationUrl: string | undefined,
  technicalDetailsLabel: string,
  errorSummary: string,
  errorNote: string,
  policyNote: string | undefined,
  rows: readonly CspHintDisplayRow[],
  suggestedDeployments: CspHintMessage['suggestedDeployments'],
}>;

function sourceLabel({ source }: { source: CspSourceDescription }): string | undefined {
  switch (source.kind) {
  case 'self': {
    const { kind: _kind, ...rest } = source;
    rest satisfies Record<PropertyKey, never>;
    return lazyStrings.CspMessageHint__this_site();
  }
  case 'loopback': {
    const { kind: _kind, ...rest } = source;
    rest satisfies Record<PropertyKey, never>;
    return lazyStrings.CspMessageHint__local_servers_on_this_pc();
  }
  case 'none': {
    const { kind: _kind, ...rest } = source;
    rest satisfies Record<PropertyKey, never>;
    return lazyStrings.CspMessageHint__no_destinations_are_allowed();
  }
  case 'host':
  case 'scheme':
  case 'other': {
    const { kind: _kind, value, ...rest } = source;
    rest satisfies Record<PropertyKey, never>;
    return value;
  }
  default: {
    const exhaustive: never = source;
    return exhaustive;
  }
  }
}

function contextLabel({ context }: { context: CspHintDetail['context'] }): string | undefined {
  switch (context) {
  case 'document': return lazyStrings.CspMessageHint__this_page();
  case 'privacy-broker': return lazyStrings.CspMessageHint__communication_page();
  case 'same-origin-worker': return lazyStrings.CspMessageHint__worker();
  default: {
    const exhaustive: never = context;
    return exhaustive;
  }
  }
}

export function describeCspHintRowsForDisplayOnly({ details }: { details: readonly CspHintDetail[] }): readonly CspHintDisplayRow[] | undefined {
  try {
    const rows: CspHintDisplayRow[] = [];
    for (const detail of details) {
      const { directive, sources, sourceDescriptions, context, ...rest } = detail;
      rest satisfies Record<PropertyKey, never>;
      const label = contextLabel({ context });
      if (label === undefined) {
        return undefined;
      }
      const sourceLabels: string[] = [];
      const seenLabels = new Set<string>();
      for (const source of sourceDescriptions) {
        const text = sourceLabel({ source });
        if (text === undefined) {
          return undefined;
        }
        if (!seenLabels.has(text)) {
          seenLabels.add(text);
          sourceLabels.push(text);
        }
      }
      if (sourceLabels.length === 0) {
        const empty = lazyStrings.CspMessageHint__no_destinations_are_listed();
        if (empty === undefined) {
          return undefined;
        }
        sourceLabels.push(empty);
      }
      rows.push({ directive, context: label, sourceLabels, serializedSources: sources.join(' ') });
    }
    return rows;
  } catch {
    return undefined;
  }
}

function activitySummaryLabel({ activity }: { activity: CspHintActivityForDisplayOnly }): string | undefined {
  switch (activity) {
  case 'connection': return lazyStrings.CspMessageHint__this_url_may_be_unreachable();
  case 'model-list': return lazyStrings.CspMessageHint__the_model_list_may_not_load();
  case 'response-generation': return lazyStrings.CspMessageHint__a_response_may_not_be_generated();
  case 'image-generation': return lazyStrings.CspMessageHint__an_image_may_not_be_generated();
  case 'title-generation': return lazyStrings.CspMessageHint__a_title_may_not_be_generated();
  case 'context-summary': return lazyStrings.CspMessageHint__the_conversation_may_not_be_summarized();
  case 'prompt-translation': return lazyStrings.CspMessageHint__the_prompt_may_not_be_translated();
  case 'model-search': return lazyStrings.CspMessageHint__model_search_may_fail();
  case 'model-information': return lazyStrings.CspMessageHint__model_information_may_not_load();
  case 'quantization-options': return lazyStrings.CspMessageHint__quantization_options_may_not_load();
  case 'download': return lazyStrings.CspMessageHint__downloads_may_fail();
  case 'running-models': return lazyStrings.CspMessageHint__running_models_may_not_be_checked();
  case 'unload-model': return lazyStrings.CspMessageHint__the_model_may_not_be_unloaded_from_memory();
  case 'wikipedia': return lazyStrings.CspMessageHint__wikipedia_may_not_be_available();
  case 'relay': return lazyStrings.CspMessageHint__the_relay_server_may_be_unreachable();
  default: {
    const exhaustive: never = activity;
    throw new Error(`Unhandled CSP display activity: ${String(exhaustive)}`);
  }
  }
}

function targetActivityForDisplayOnly({ target }: { target: CspHintTarget | undefined }): CspHintActivityForDisplayOnly | undefined {
  if (target === undefined) {
    return undefined;
  }
  switch (target.kind) {
  case 'huggingface-download': return 'download';
  case 'huggingface-metadata': return 'model-information';
  case 'wikipedia': return 'wikipedia';
  case 'relay': return 'relay';
  case 'connection':
  case 'resource':
  case 'resource-list': return undefined;
  default: {
    const exhaustive: never = target;
    throw new Error(`Unhandled CSP display target: ${String(exhaustive)}`);
  }
  }
}

function summaryLabel({ subject, target, activityForDisplayOnly }: { subject: CspHintMessage['subject'], target: CspHintTarget | undefined, activityForDisplayOnly: CspHintActivityForDisplayOnly | undefined }): string | undefined {
  const activity = activityForDisplayOnly ?? targetActivityForDisplayOnly({ target });
  if (activity !== undefined) {
    return activitySummaryLabel({ activity });
  }
  switch (subject) {
  case 'connection':
  case 'wikipedia':
  case 'huggingface': return lazyStrings.CspMessageHint__this_connection_may_be_restricted();
  case 'image': return lazyStrings.CspMessageHint__this_image_may_not_be_displayed();
  case 'media': return lazyStrings.CspMessageHint__this_media_may_not_play();
  case 'form': return lazyStrings.CspMessageHint__this_form_may_not_be_submitted();
  case 'resource': return lazyStrings.CspMessageHint__some_content_or_actions_may_be_restricted();
  case 'frame':
  case 'worker':
  case 'script':
  case 'style':
  case 'font':
  case 'manifest': return lazyStrings.CspMessageHint__this_resource_may_not_load();
  default: {
    const exhaustive: never = subject;
    return exhaustive;
  }
  }
}

function explanationLabel({ subject, url }: { subject: CspHintMessage['subject'], url: string | undefined }): string | undefined {
  switch (subject) {
  case 'connection': return lazyStrings.CspMessageHint__this_destination_is_outside_the_allowed_range({ url });
  case 'wikipedia':
  case 'huggingface':
  case 'resource': return lazyStrings.CspMessageHint__some_required_connections_or_loads_are_outside_the_allowed_range();
  case 'form': return lazyStrings.CspMessageHint__this_submission_destination_is_outside_the_allowed_range({ url });
  case 'image':
  case 'media':
  case 'frame':
  case 'worker':
  case 'script':
  case 'style':
  case 'font':
  case 'manifest': return lazyStrings.CspMessageHint__this_resource_source_is_outside_the_allowed_range({ url });
  default: {
    const exhaustive: never = subject;
    return exhaustive;
  }
  }
}

function destinationUrlForDisplayOnly({ target }: { target: CspHintTarget | undefined }): string | undefined {
  try {
    if (target === undefined) {
      return undefined;
    }
    let serialized: string | undefined;
    switch (target.kind) {
    case 'connection': serialized = target.endpoint;
      break;
    case 'relay': serialized = target.url;
      break;
    case 'resource': serialized = target.url;
      break;
    case 'wikipedia':
    case 'huggingface-metadata':
    case 'huggingface-download':
    case 'resource-list': return undefined;
    default: {
      const exhaustive: never = target;
      throw exhaustive;
    }
    }
    if (serialized === undefined || serialized.length > 4_096) {
      return undefined;
    }
    // Identify the configured destination, not an inferred blocked request.
    // Relative URLs and local object/data URLs are deliberately not displayed.
    const value = serialized.trim();
    if (!/^(?:https?|wss?):\/\//i.test(value)) {
      return undefined;
    }
    const url = new URL(value);
    switch (url.protocol) {
    case 'http:':
    case 'https:':
    case 'ws:':
    case 'wss:': break;
    default: return undefined;
    }
    url.username = '';
    url.password = '';
    url.search = '';
    url.hash = '';
    const displayed = url.href;
    return displayed.length <= 512 ? displayed : undefined;
  } catch {
    // URL formatting is an optional supplement; the existing hint must survive.
    return undefined;
  }
}

export function describeCspHintForDisplayOnly({ message, target, activityForDisplayOnly, presentation }: { message: CspHintMessage | undefined, target: CspHintTarget | undefined, activityForDisplayOnly: CspHintActivityForDisplayOnly | undefined, presentation: 'compact' | 'error' }): CspHintDisplayCopy | undefined {
  try {
    if (message === undefined) {
      return undefined;
    }
    const { tone: _tone, subject, details, suggestedDeployments, ...rest } = message;
    rest satisfies Record<PropertyKey, never>;
    const errorSummary = lazyStrings.CspMessageHint__hints_for_resolving_this_error();
    let summary: string | undefined;
    switch (presentation) {
    case 'compact': summary = summaryLabel({ subject, target, activityForDisplayOnly });
      break;
    case 'error': summary = errorSummary;
      break;
    default: {
      const exhaustive: never = presentation;
      throw new Error(`Unhandled CSP hint presentation: ${String(exhaustive)}`);
    }
    }
    const title = lazyStrings.CspMessageHint__the_following_destinations_are_allowed();
    const destinationUrl = destinationUrlForDisplayOnly({ target });
    const explanation = explanationLabel({ subject, url: destinationUrl });
    const technicalDetailsLabel = lazyStrings.CspMessageHint__technical_details();
    const errorNote = lazyStrings.CspMessageHint__current_policy_does_not_identify_the_error_cause();
    const rows = describeCspHintRowsForDisplayOnly({ details });
    const policyNote = details.length > 1 ? lazyStrings.CspMessageHint__each_policy_applies_separately() : undefined;
    if (summary === undefined || title === undefined || explanation === undefined || technicalDetailsLabel === undefined || errorSummary === undefined
      || errorNote === undefined || rows === undefined || (details.length > 1 && policyNote === undefined)) {
      return undefined;
    }
    return { summary, title, explanation, destinationUrl, technicalDetailsLabel, errorSummary, errorNote, rows, policyNote, suggestedDeployments };
  } catch {
    // Missing or broken message formatting must remove the entire hint.
    return undefined;
  }
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
