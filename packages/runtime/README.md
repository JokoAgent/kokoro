# `@kokoro/runtime`

The host implementation of the Kokoro Persona harness. External integrations should depend on `@kokoro/protocol` and `@kokoro/client`; this package composes the Runtime, Store, Repository, Provider, Tool, Prompt, Memory, and protocol server.

Runtime facts and model sessions remain outside Persona Git repositories. Checkpoints contain Persona files only. External effects move through durable intent, authorization, outcome recording, and recovery; an uncertain result remains `unknown`.

`ProtocolServer` exposes the public boundary through a transport-independent `ByteConnection`. Owner documents cross that boundary only as repository-relative paths and content digests, with writes protected by revisions, writer leases, and file SHA-256 compare-and-swap.
