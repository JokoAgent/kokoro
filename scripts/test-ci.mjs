import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createOwnedTempDirectory,
  prepareIsolatedEnvironment,
  removeOwnedTempDirectory,
  runChecked,
  vitestCliPath,
} from "./release-utils.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const owned = createOwnedTempDirectory("kokoro-test-", repositoryRoot);
let failure;

try {
  const environment = prepareIsolatedEnvironment(owned.root, { preserveCi: true });
  environment.KOKORO_TEST_ISOLATED_ROOT = owned.root;
  process.stdout.write(`Running the CI test suite in ${owned.root}\n`);
  runChecked(
    process.execPath,
    [vitestCliPath(), "run", "--root", repositoryRoot, "--config", join(repositoryRoot, "vitest.config.ts")],
    { cwd: repositoryRoot, env: environment },
  );
} catch (error) {
  failure = error;
} finally {
  try {
    removeOwnedTempDirectory(owned, repositoryRoot);
  } catch (cleanupError) {
    failure = failure ?? cleanupError;
    if (failure !== cleanupError) process.stderr.write(`${formatError(cleanupError)}\n`);
  }
}

if (failure) {
  process.stderr.write(`${formatError(failure)}\n`);
  process.exitCode = 1;
}

function formatError(error) {
  return error instanceof Error ? (error.stack ?? error.message) : String(error);
}
