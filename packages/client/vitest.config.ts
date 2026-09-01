import { fileURLToPath } from "node:url";

export default {
  resolve: {
    alias: {
      "@kokoro/protocol": fileURLToPath(new URL("../protocol/src/index.ts", import.meta.url)),
    },
  },
  test: {
    include: ["test/**/*.test.ts"],
    testTimeout: 30_000,
  },
};
