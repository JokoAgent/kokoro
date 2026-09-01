# `@kokoro/client`

A transport-neutral client for Kokoro's public protocol. The package root has no Node dependency; the Node IPC transport is exported separately from `@kokoro/client/node`.

```ts
import { KokoroClient } from "@kokoro/client";

const client = new KokoroClient({
  clientName: "owner",
  clientVersion: "1.0.0",
  transportFactory,
});

// Register before connect: the client does not retain events for listeners that
// were not present when those events arrived.
const bufferedObservations = [];
client.subscribeObservations((record) => bufferedObservations.push(record));

await client.connect();

const result = await client.submitStimulus({
  personaId: "persona-1",
  idempotencyKey: "message-1",
  stimulus: {
    kind: "user_message",
    content: { text: "Hello" },
    occurredAt: new Date().toISOString(),
    source: "owner",
  },
});
```

The client handles the handshake, frame validation, request correlation, and authoritative snapshots. It does not keep optimistic authority, retain missed live events, persist observation cursors, or reconnect automatically. A long-lived host must register listeners before `connect()`, buffer live observations while paging durable observations from its last persisted cursor, merge by cursor/observation ID, and only then switch to live projection.

Authentication belongs to the host transport, not the public protocol. A disconnect rejects pending requests; after a mutation timeout or transport loss, consumers must treat the outcome as potentially changed unless a command-specific durable reconciliation path proves otherwise.
