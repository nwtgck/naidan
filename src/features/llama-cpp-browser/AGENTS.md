# Design intent

Keep `llama-cpp-browser-core` (lcore) thin: primarily llama.cpp compiled to Wasm, with the Emscripten JavaScript and bindings needed to use it. Its separate repository keeps infrequent Wasm builds and artifact publication out of Naidan's build. Naidan is its only intended consumer; breaking changes are acceptable to simplify lcore.

Keep lcore independent of Naidan. Do not introduce Naidan-specific names or assumptions into its repository unless explicitly requested.

Keep application behavior and control in Naidan, including model storage and lifetime, workers, generation loops, and tool execution. Expose upstream capabilities without introducing lcore-specific workflows that constrain how Naidan uses them.

Keep lcore's handwritten JavaScript helpers as a tested example runtime and include it in artifacts. Use it as a reference for Naidan's own TypeScript integration rather than importing it as Naidan's runtime.

Aim to make all upstream chat capabilities, including tools and multimodal inputs, accessible from Naidan without further lcore changes. When a capability is missing, consider extending the thin bindings to the existing upstream implementation before recreating it in Naidan.
