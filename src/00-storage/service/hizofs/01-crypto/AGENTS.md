# HizoFS cryptographic execution boundary

This directory owns Web Crypto execution, secure randomness, secret and key lifetime, typed authentication failure normalization, and purpose-specific opaque cryptographic capabilities.

Persisted algorithms, KDF parameters, nonce and tag sizes, domains, contexts, AAD, and encoded credential contracts belong to `../00-format/` and must be imported from that authority. Do not redeclare persisted compatibility contracts here.

This directory does not own runtime or session orchestration, UI, diagnostics, OPFS, or physical I/O. Keep public APIs purpose-specific; do not expose general encryption, arbitrary AAD, random-byte, or raw Root Key bridges through the public index.
