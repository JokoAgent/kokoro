# `@kokoro/cli`

The local Kokoro harness process and protocol command-line interface.

```text
kokoro serve --config <file>
kokoro request --socket <path> --json <command>
```

`serve` creates a Runtime from the config and listens on local IPC. `request` sends one public protocol command and prints its result with the authoritative snapshot. Configuration stores credential environment-variable names, never credential values.

Run `kokoro --help` for the complete command and configuration reference.
