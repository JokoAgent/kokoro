# `@kokoro/protocol`

Kokoro's stable, independent, transport-neutral public boundary. The package contains DTOs, strict validation, framing, and compatibility contracts. It does not depend on Runtime, storage, Git, Provider, Tool, or server implementations.

Messages are UTF-8 JSON with a four-byte big-endian length prefix. A connection begins with a correlated `hello`; requests, responses, and events carry correlation data and a complete `AuthoritySnapshot`. Snapshots at the same revision must be identical, and mutations can use `expectedRevision` for admission control.

Protocol-owned objects reject unknown fields recursively. An incompatible wire shape requires a new negotiated protocol version. Stable examples live in `fixtures/protocol-v1.golden.json`.

```ts
import { JsonFrameDecoder, encodeClientEnvelope } from "@kokoro/protocol";

const frame = encodeClientEnvelope({
  protocol: "kokoro/1",
  kind: "hello",
  messageId: "hello-1",
  correlationId: "connection-1",
  client: { name: "owner", version: "1.0.0" },
  maxFrameBytes: 16 * 1024 * 1024,
});

const decoder = new JsonFrameDecoder();
decoder.push(frame);
```
