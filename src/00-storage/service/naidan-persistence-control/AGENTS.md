# Naidan Persistence Control ownership

This directory owns Naidan-specific selection between plain storage, HizoFS-backed storage, and explicit transitions. It is not part of portable HizoFS.

`00-format/` is the sole owner of the persisted A/B control representation, proof classification, sequence selection, canonical control JSON, and control-specific cryptographic domains. Runtime transition orchestration and OPFS I/O stay outside `00-format/`.

Do not duplicate HizoFS container codecs, credential slots, root-key handling, or portable cryptographic contexts here. This owner may consume portable compatibility primitives from HizoFS but HizoFS must never import this directory.
