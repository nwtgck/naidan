// This diagnostic-only module must remain lazy. Its CSS marker proves that a
// dynamically loaded SystemJS chunk can also inject the CSS owned by that chunk.
import './lazy-style-probe.css'

export const STANDALONE_VERIFICATION_LAZY_STYLE_MARKER = 'standalone-verification-lazy-style-probe-v1'
