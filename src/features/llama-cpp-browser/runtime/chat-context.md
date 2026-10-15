# Experimental chat context allocation

The persisted settings DTO (Data Transfer Object) accepts an optional target:

```json
{
  "experimental": {
    "llamaCppBrowser": {
      "contextTokens": 65536
    }
  }
}
```

Change the target in Settings → llama.cpp browser → Inference settings → Context
size (tokens). The input saves on change; Reset to default removes the saved
override and restores the 32,768-token target. Changes apply to the next independent
chat operation, including model preparation, and do not resize an ongoing generation.

The JSON above is a fragment to merge into the existing settings record, not a
replacement for the whole record. The normal settings import/persistence path
also accepts this DTO field for the selected storage provider. Removing it
restores the 32,768-token target.

At the runtime boundary a target must be an integer from 512 to 1,048,576.
The DTO describes the stored number structurally; malformed/unsafe values are
rejected before acquiring the inference worker rather than silently replaced.
Explicit runtime options override the saved value. Audio uses its existing,
separate context target and never inherits this chat preference.

The target is captured before queuing a request and remains fixed through one
owned tool loop or performance operation. The next independent operation reads
settings again. Changing global settings during a generation does not resize an
in-flight native context. A different target rebuilds the context, its checkpoint
and its prefix cache, but retains unchanged model weights and required file-backed
shards. Old context resources are released before a new one is allocated. The
first generation after a resize must therefore prefill its history again.

The actual native allocation is capped by the model's training-context metadata.
The existing allocation fallback may reduce the logical batch and then the
context target if normal native initialization returns null. Diagnostics report
`requestedContextTokens` separately from effective `contextTokens`. A successful
smaller allocation is remembered, so repeated requests do not retry it endlessly.
Native traps/exceptions are not treated as an ordinary capacity retry.

`context-full` during tokenization usually means that the complete formatted
prompt exceeds the effective context minus one reserved generation token. It
includes conversation history, system text and tool results, not merely the
previous generation's reported token count. Safe diagnostic counts now show the
required token count and actual capacity when the native tokenizer supplies a
representable length. The overflow sentinel has no trustworthy required count.

The separate 4 MiB formatted-prompt byte guard is unchanged. This feature does
not introduce history truncation, summarization, automatic context shifting,
training-limit extrapolation or a larger output-token budget. A larger context
consumes more cache/working memory and can slow attention; increasing it is not
itself a speed optimization. Prefer a target that fits the intended history and
the actual device, and use a fresh chat or shorten history when appropriate.
