import { access, mkdir, mkdtemp, rm, stat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { KokoroRuntime, PersonaRepository } from "../src/index.js";

const sandboxes: string[] = [];
const runtimes = new Set<KokoroRuntime>();

afterEach(async () => {
  for (const runtime of runtimes) await runtime.close();
  runtimes.clear();
  await Promise.all(sandboxes.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Runtime authority filesystem identity", () => {
  it.each([
    {
      capability: "case",
      canonicalName: "Authority-Case",
      alternateName: "authority-case",
    },
    {
      capability: "Unicode normalization",
      canonicalName: "Authority-\u00e9",
      alternateName: "Authority-e\u0301",
    },
  ])(
    "follows the filesystem's $capability behavior when both roots are initially absent",
    async ({ canonicalName, alternateName }) => {
      const root = await sandbox("kokoro-authority-equivalence-");
      const equivalent = await namesReferToSameDirectory(root, canonicalName, alternateName);
      const authorityRoot = path.join(root, "authority-roots");
      const stateDirectory = path.join(authorityRoot, canonicalName);
      const personaDirectory = path.join(authorityRoot, alternateName);

      const opening = KokoroRuntime.open({ stateDirectory, personaDirectory });
      if (equivalent) {
        await expect(opening).rejects.toMatchObject({
          name: "RuntimeStateError",
          code: "invalid_request",
        });
        await expect(access(path.join(stateDirectory, "kokoro.sqlite3"))).rejects.toMatchObject({
          code: "ENOENT",
        });
      } else {
        const runtime = await opening;
        await runtime.close();
      }
    },
  );

  it("rejects authority roots that are the same directory through a symlink or junction", async () => {
    const root = await sandbox("kokoro-authority-link-");
    const authority = path.join(root, "authority");
    const alias = path.join(root, "authority-alias");
    await mkdir(authority);
    await symlink(authority, alias, "junction");

    await expect(
      KokoroRuntime.open({ stateDirectory: authority, personaDirectory: alias }),
    ).rejects.toMatchObject({ name: "RuntimeStateError", code: "invalid_request" });
    await expect(access(path.join(authority, "kokoro.sqlite3"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("rejects a physically nested authority root reached through a symlink or junction", async () => {
    const root = await sandbox("kokoro-authority-link-nested-");
    const authority = path.join(root, "authority");
    const alias = path.join(root, "authority-alias");
    await mkdir(authority);
    await symlink(authority, alias, "junction");

    await expect(
      KokoroRuntime.open({
        stateDirectory: authority,
        personaDirectory: path.join(alias, "personas"),
      }),
    ).rejects.toMatchObject({ name: "RuntimeStateError", code: "invalid_request" });
    await expect(access(path.join(authority, "kokoro.sqlite3"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("rejects a Persona destination that aliases Runtime state", async () => {
    const root = await sandbox("kokoro-persona-authority-alias-");
    const runtime = await trackedRuntime(root);
    const personaAlias = path.join(runtime.personaDirectory, "state-alias");
    await symlink(runtime.stateDirectory, personaAlias, "junction");

    await expect(
      runtime.createPersona({
        personaId: "state-alias",
        displayName: "State Alias",
        uiLocale: "en",
        promptLocale: "en",
      }),
    ).rejects.toMatchObject({ name: "RuntimeStateError", code: "invalid_request" });
    expect(runtime.store.getPersona("state-alias")).toBeUndefined();
  });

  it("rejects a Clone destination that aliases its source repository", async () => {
    const root = await sandbox("kokoro-clone-authority-alias-");
    const runtime = await trackedRuntime(root);
    const source = await initializedPersona(runtime, "clone-source");
    const cloneAlias = path.join(runtime.personaDirectory, "clone-alias");
    await symlink(source.repositoryPath, cloneAlias, "junction");

    await expect(
      runtime.clone({
        personaId: source.id,
        checkpoint: source.checkpoint,
        newPersonaId: "clone-alias",
        displayName: "Clone Alias",
      }),
    ).rejects.toMatchObject({ name: "RuntimeStateError", code: "invalid_request" });
    expect(runtime.store.preparedRepositoryOperations()).toEqual([]);
  });

  it("allows a genuinely separate Clone destination that is initially absent", async () => {
    const root = await sandbox("kokoro-clone-authority-distinct-");
    const runtime = await trackedRuntime(root);
    const source = await initializedPersona(runtime, "distinct-source");

    const clone = await runtime.clone({
      personaId: source.id,
      checkpoint: source.checkpoint,
      newPersonaId: "distinct-clone",
      displayName: "Distinct Clone",
    });

    expect(clone.repositoryPath).toBe(path.join(runtime.personaDirectory, "distinct-clone"));
    expect(clone.repositoryPath).not.toBe(source.repositoryPath);
  });

  it("fails a persisted Clone whose destination was replaced by a source alias", async () => {
    const root = await sandbox("kokoro-clone-recovery-alias-");
    const runtime = await trackedRuntime(root);
    const source = await initializedPersona(runtime, "recovery-source");
    const cloneId = "recovery-alias";
    const destination = path.join(runtime.personaDirectory, cloneId);
    await symlink(source.repositoryPath, destination, "junction");
    runtime.store.saveRepositoryOperation({
      id: "recovery-alias-operation",
      personaId: source.id,
      kind: "clone",
      payload: {
        checkpoint: source.checkpoint,
        newPersonaId: cloneId,
        displayName: "Recovery Alias",
        destination,
        uiLocale: "en",
        promptLocale: "en",
      },
      now: 100,
    });
    await closeTrackedRuntime(runtime);

    const recovered = await trackedRuntime(root);
    expect(recovered.store.getPersona(cloneId)).toBeUndefined();
    expect(recovered.store.preparedRepositoryOperations()).toEqual([]);
    expect(recovered.store.requirePersona(source.id).repositoryPath).toBe(source.repositoryPath);
  });
});

describe("Persona repository filesystem identity", () => {
  it("accepts an equivalent repository-root spelling returned across a link boundary", async () => {
    const root = await sandbox("kokoro-repository-link-");
    const repositoryRoot = path.join(root, "repository");
    const alias = path.join(root, "repository-alias");
    await PersonaRepository.createDraft(repositoryRoot, {
      persona: "# Persona\n",
      memory: "# Memory\n",
    });
    await symlink(repositoryRoot, alias, "junction");

    const repository = await PersonaRepository.inspect(alias);
    expect(repository.root).toBe(path.resolve(alias));
  });
});

async function sandbox(prefix: string): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), prefix));
  sandboxes.push(root);
  return root;
}

async function trackedRuntime(root: string): Promise<KokoroRuntime> {
  const runtime = await KokoroRuntime.open({
    stateDirectory: path.join(root, "state"),
    personaDirectory: path.join(root, "personas"),
  });
  runtimes.add(runtime);
  return runtime;
}

async function closeTrackedRuntime(runtime: KokoroRuntime): Promise<void> {
  await runtime.close();
  runtimes.delete(runtime);
}

async function initializedPersona(
  runtime: KokoroRuntime,
  personaId: string,
): Promise<{ id: string; repositoryPath: string; checkpoint: string }> {
  const persona = await runtime.createPersona({
    personaId,
    displayName: personaId,
    uiLocale: "en",
    promptLocale: "en",
  });
  const initialized = await runtime.initialize(persona.id);
  if (initialized.currentCheckpoint === null) {
    throw new Error("The test Persona did not produce a root Checkpoint.");
  }
  return {
    id: persona.id,
    repositoryPath: persona.repositoryPath,
    checkpoint: initialized.currentCheckpoint,
  };
}

async function namesReferToSameDirectory(
  root: string,
  canonicalName: string,
  alternateName: string,
): Promise<boolean> {
  const probe = path.join(root, "filesystem-probe");
  const canonical = path.join(probe, canonicalName);
  const alternate = path.join(probe, alternateName);
  await mkdir(canonical, { recursive: true });
  const canonicalInformation = await stat(canonical, { bigint: true });
  const alternateInformation = await stat(alternate, { bigint: true }).catch(() => undefined);
  await rm(probe, { recursive: true, force: true });
  return (
    alternateInformation !== undefined &&
    canonicalInformation.dev === alternateInformation.dev &&
    canonicalInformation.ino === alternateInformation.ino
  );
}
