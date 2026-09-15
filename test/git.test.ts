import { spawnSync } from "node:child_process";
import { chmod, mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import {
  connectRemote,
  getGitStatus,
  initStoreGit,
  syncGitStore,
} from "../src/core/git.js";
import { hashScannedLine, scanStoreForSecrets } from "../src/core/secret-scan.js";
import { partitionByAllowlist } from "../src/core/secret-allowlist.js";
import { backupCanonicalStore } from "../src/core/backup.js";
import { acquireLock } from "../src/core/fs.js";
import { initializeProject } from "../src/core/project.js";
import { loadHarness, writeHarness } from "../src/core/config.js";

const GIT_AVAILABLE = spawnSync("git", ["--version"], {
  encoding: "utf8",
  shell: false,
}).status === 0;

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe.skipIf(!GIT_AVAILABLE)("Git store sync", () => {
  it("initializes an independent store repository and reports its status", async () => {
    const root = await makeTempRoot();
    git(root, ["init", "--quiet"]);
    const store = join(root, "nested-store");

    const status = await initStoreGit(store, "main");

    expect(status).toMatchObject({
      initialized: true,
      branch: "main",
      detached: false,
      clean: true,
    });
    expect(await realpath(git(store, ["rev-parse", "--show-toplevel"]))).toBe(
      await realpath(store),
    );
  });

  it("commits, pushes, and becomes a no-op when nothing changed", async () => {
    const root = await makeTempRoot();
    const remote = join(root, "personal-store.git");
    const store = join(root, "store");
    await mkdir(remote);
    git(remote, ["init", "--quiet", "--bare"]);
    await initStoreGit(store, "main");
    configureIdentity(store);
    await writeFile(join(store, "harness.yaml"), "schemaVersion: 1\n", "utf8");

    const connection = await connectRemote(store, remote, "origin");
    const first = await syncGitStore(store, {
      branch: "main",
      remote: "origin",
      commitMessage: "initial harness",
      push: true,
    });
    const second = await syncGitStore(store, {
      branch: "main",
      remote: "origin",
      push: true,
    });

    expect(connection).toEqual({ remote: "origin", created: true });
    expect(first).toMatchObject({ committed: true, pushed: true });
    expect(first.commit).toMatch(/^[a-f\d]{40,64}$/u);
    expect(git(remote, ["show-ref", "--verify", "refs/heads/main"])).toContain(
      "refs/heads/main",
    );
    expect(second).toMatchObject({ committed: false, fetched: true, pushed: true });
    expect(second.status.clean).toBe(true);
    expect(second.status.upstream).toBe("origin/main");
  });



  it("commits when every finding is matched by a reviewed allowlist entry", async () => {
    const root = await makeTempRoot();
    const store = join(root, "store");
    await initStoreGit(store, "main");
    configureIdentity(store);
    const placeholder = 'export API_TOKEN="your-token-here"';
    await writeFile(join(store, "docs.md"), `${placeholder}\n`, "utf8");

    const findings = await scanStoreForSecrets(store);
    expect(findings).toHaveLength(1);

    const approved = partitionByAllowlist(findings, [{
      path: "docs.md",
      rule: "literal-secret-field",
      lineHash: hashScannedLine(placeholder),
      reason: "documentation placeholder, reviewed",
    }]);
    expect(approved.blocking).toEqual([]);

    // and the same scan still blocks when the line becomes a real credential
    await writeFile(join(store, "docs.md"), 'export API_TOKEN="Zk8sQ1vB3nM7pL0aX2c4"\n', "utf8");
    const after = partitionByAllowlist(await scanStoreForSecrets(store), [{
      path: "docs.md",
      rule: "literal-secret-field",
      lineHash: hashScannedLine(placeholder),
      reason: "documentation placeholder, reviewed",
    }]);
    expect(after.blocking).toHaveLength(1);
    expect(after.stale).toHaveLength(1);
  });

  it("never commits a generated cache that grew inside a required skill", async () => {
    const root = await makeTempRoot();
    const store = join(root, "store");
    await initStoreGit(store, "main");
    configureIdentity(store);
    await writeFile(join(store, "harness.yaml"), "schemaVersion: 1\n", "utf8");
    await writeFile(join(store, ".gitignore"), "__pycache__/\nnode_modules/\n", "utf8");
    await mkdir(join(store, "skills", "demo", "__pycache__"), { recursive: true });
    await mkdir(join(store, "skills", "demo", "deps", "node_modules"), { recursive: true });
    await writeFile(join(store, "skills", "demo", "SKILL.md"), "---\nname: demo\n---\nbody\n");
    await writeFile(join(store, "skills", "demo", "__pycache__", "x.pyc"), "cache\n");
    await writeFile(join(store, "skills", "demo", "deps", "node_modules", "y.js"), "dep\n");

    // the skill is a required canonical path, so it is staged with --force
    await syncGitStore(store, {
      branch: "main",
      remote: "origin",
      commitMessage: "with a skill bundle",
      push: false,
      requiredPaths: ["harness.yaml", "skills/demo"],
    });

    const tracked = git(store, ["ls-files"]).split("\n").filter(Boolean);
    expect(tracked).toContain("skills/demo/SKILL.md");
    expect(tracked.filter((path) => path.includes("__pycache__"))).toEqual([]);
    expect(tracked.filter((path) => path.includes("node_modules"))).toEqual([]);
  });

  it("validates the exact staged tree before moving the branch", async () => {
    const root = await makeTempRoot();
    const store = join(root, "store");
    await initStoreGit(store, "main");
    configureIdentity(store);
    await writeFile(join(store, "harness.yaml"), "schemaVersion: 1\n", "utf8");
    await syncGitStore(store, { branch: "main", commitMessage: "base" });
    const before = git(store, ["rev-parse", "HEAD"]);
    await writeFile(
      join(store, "zzzz-last.txt"),
      "api_key = private-race-secret-value-1234567890\n",
      "utf8",
    );

    await expect(syncGitStore(store, {
      branch: "main",
      commitMessage: "must not activate",
      validateCandidate: async (candidateStoreDir) => {
        const findings = await scanStoreForSecrets(candidateStoreDir);
        if (findings.length > 0) throw new Error("candidate secret found");
      },
    })).rejects.toThrow(/candidate secret found/u);

    expect(git(store, ["rev-parse", "HEAD"])).toBe(before);
    expect(git(store, ["log", "-1", "--pretty=%s"])).toBe("base");
  });

  it("fetches and rebases divergent non-conflicting changes before pushing", async () => {
    const root = await makeTempRoot();
    const remote = join(root, "personal-store.git");
    const store = join(root, "store");
    const peer = join(root, "peer");
    await mkdir(remote);
    git(remote, ["init", "--quiet", "--bare"]);
    await initStoreGit(store, "main");
    configureIdentity(store);
    await writeFile(join(store, "harness.yaml"), "schemaVersion: 1\n", "utf8");
    await connectRemote(store, remote);
    await syncGitStore(store, { branch: "main", commitMessage: "base", push: true });

    git(root, ["clone", "--quiet", "--branch", "main", remote, peer]);
    configureIdentity(peer);
    await writeFile(join(peer, "from-peer.md"), "peer\n", "utf8");
    git(peer, ["add", "--all", "--", "."]);
    git(peer, ["commit", "--quiet", "--message", "peer change"]);
    git(peer, ["push", "--quiet", "origin", "main"]);

    await writeFile(join(store, "from-local.md"), "local\n", "utf8");
    const review = await syncGitStore(store, {
      branch: "main",
      commitMessage: "local change",
    });
    const result = await syncGitStore(store, {
      branch: "main",
      push: true,
      acceptRemote: review.reviewCommit!,
      validateCandidate: async (candidateStoreDir) => {
        expect(candidateStoreDir).not.toBe(store);
        expect(await readFile(join(candidateStoreDir, "from-peer.md"), "utf8"))
          .toBe("peer\n");
        expect(await readFile(join(candidateStoreDir, "from-local.md"), "utf8"))
          .toBe("local\n");
      },
    });

    expect(result).toMatchObject({
      committed: false,
      fetched: true,
      rebased: true,
      pushed: true,
    });
    expect(await readFile(join(store, "from-peer.md"), "utf8")).toBe("peer\n");
    expect(await readFile(join(store, "from-local.md"), "utf8")).toBe("local\n");
    expect(git(store, ["rev-list", "--count", "HEAD"])).toBe("3");
  });

  it("fetches remote changes without activating them until explicitly accepted", async () => {
    const root = await makeTempRoot();
    const remote = join(root, "personal-store.git");
    const store = join(root, "store");
    const peer = join(root, "peer");
    await mkdir(remote);
    git(remote, ["init", "--quiet", "--bare"]);
    await initStoreGit(store, "main");
    configureIdentity(store);
    await writeFile(join(store, "harness.yaml"), "schemaVersion: 1\n", "utf8");
    await connectRemote(store, remote);
    await syncGitStore(store, { branch: "main", commitMessage: "base", push: true });

    git(root, ["clone", "--quiet", "--branch", "main", remote, peer]);
    configureIdentity(peer);
    await writeFile(join(peer, "remote-hook.md"), "not active yet\n", "utf8");
    git(peer, ["add", "--all", "--", "."]);
    git(peer, ["commit", "--quiet", "--message", "remote change"]);
    git(peer, ["push", "--quiet", "origin", "main"]);

    const review = await syncGitStore(store, { branch: "main" });
    expect(review).toMatchObject({
      fetched: true,
      remoteChangesPending: true,
      fastForwarded: false,
      rebased: false,
    });
    await expect(readFile(join(store, "remote-hook.md"), "utf8")).rejects.toThrow();

    const accepted = await syncGitStore(store, {
      branch: "main",
      acceptRemote: review.reviewCommit!,
    });
    expect(accepted).toMatchObject({
      remoteChangesPending: false,
      fastForwarded: true,
    });
    expect(await readFile(join(store, "remote-hook.md"), "utf8")).toBe(
      "not active yet\n",
    );
  });

  it("validates a reviewed candidate in isolation before changing the live store", async () => {
    const root = await makeTempRoot();
    const remote = join(root, "personal-store.git");
    const store = join(root, "store");
    const peer = join(root, "peer");
    await mkdir(remote);
    git(remote, ["init", "--quiet", "--bare"]);
    await initStoreGit(store, "main");
    configureIdentity(store);
    await writeFile(join(store, "harness.yaml"), "schemaVersion: 1\n", "utf8");
    await connectRemote(store, remote);
    await syncGitStore(store, { branch: "main", commitMessage: "base", push: true });
    const before = git(store, ["rev-parse", "HEAD"]);

    git(root, ["clone", "--quiet", "--branch", "main", remote, peer]);
    configureIdentity(peer);
    await writeFile(join(peer, "invalid.md"), "invalid candidate\n", "utf8");
    git(peer, ["add", "--all", "--", "."]);
    git(peer, ["commit", "--quiet", "--message", "invalid candidate"]);
    git(peer, ["push", "--quiet", "origin", "main"]);
    const review = await syncGitStore(store, { branch: "main" });

    await expect(
      syncGitStore(store, {
        branch: "main",
        acceptRemote: review.reviewCommit!,
        validateCandidate: async (candidateStoreDir) => {
          expect(candidateStoreDir).not.toBe(store);
          expect(await readFile(join(candidateStoreDir, "invalid.md"), "utf8"))
            .toBe("invalid candidate\n");
          throw new Error("candidate validation failed");
        },
      }),
    ).rejects.toThrow(/candidate validation failed/u);

    expect(git(store, ["rev-parse", "HEAD"])).toBe(before);
    await expect(readFile(join(store, "invalid.md"), "utf8")).rejects.toThrow();
  });

  it("does not report an exact remote activation when HEAD changes during validation", async () => {
    const root = await makeTempRoot();
    const remote = join(root, "personal-store.git");
    const store = join(root, "store");
    const peer = join(root, "peer");
    await mkdir(remote);
    git(remote, ["init", "--quiet", "--bare"]);
    await initStoreGit(store, "main");
    configureIdentity(store);
    await writeFile(join(store, "harness.yaml"), "schemaVersion: 1\n", "utf8");
    await connectRemote(store, remote);
    await syncGitStore(store, { branch: "main", commitMessage: "base", push: true });

    git(root, ["clone", "--quiet", "--branch", "main", remote, peer]);
    configureIdentity(peer);
    await writeFile(join(peer, "reviewed.md"), "reviewed\n", "utf8");
    git(peer, ["add", "--all", "--", "."]);
    git(peer, ["commit", "--quiet", "--message", "reviewed"]);
    git(peer, ["push", "--quiet", "origin", "main"]);
    const review = await syncGitStore(store, { branch: "main" });

    await expect(syncGitStore(store, {
      branch: "main",
      acceptRemote: review.reviewCommit!,
      validateCandidate: async () => {
        git(store, ["merge", "--quiet", "--ff-only", review.reviewCommit!]);
        await writeFile(join(store, "external.md"), "external descendant\n", "utf8");
        git(store, ["add", "--all", "--", "."]);
        git(store, ["commit", "--quiet", "--message", "external descendant"]);
      },
    })).rejects.toThrow(/HEAD changed while the reviewed candidate was validated/u);

    expect(git(store, ["rev-parse", "HEAD"])).not.toBe(review.reviewCommit);
    expect(git(store, ["merge-base", "--is-ancestor", review.reviewCommit!, "HEAD"]))
      .toBe("");
    expect(await readFile(join(store, "external.md"), "utf8"))
      .toBe("external descendant\n");
  });

  it("accepts the exact reviewed commit even if the remote advances afterward", async () => {
    const root = await makeTempRoot();
    const remote = join(root, "personal-store.git");
    const store = join(root, "store");
    const peer = join(root, "peer");
    await mkdir(remote);
    git(remote, ["init", "--quiet", "--bare"]);
    await initStoreGit(store, "main");
    configureIdentity(store);
    await writeFile(join(store, "harness.yaml"), "schemaVersion: 1\n", "utf8");
    await connectRemote(store, remote);
    await syncGitStore(store, { branch: "main", commitMessage: "base", push: true });
    git(root, ["clone", "--quiet", "--branch", "main", remote, peer]);
    configureIdentity(peer);
    await writeFile(join(peer, "reviewed.md"), "reviewed\n", "utf8");
    git(peer, ["add", "--all", "--", "."]);
    git(peer, ["commit", "--quiet", "--message", "reviewed A"]);
    git(peer, ["push", "--quiet", "origin", "main"]);

    const review = await syncGitStore(store, { branch: "main" });
    await writeFile(join(peer, "unreviewed.md"), "unreviewed\n", "utf8");
    git(peer, ["add", "--all", "--", "."]);
    git(peer, ["commit", "--quiet", "--message", "unreviewed B"]);
    git(peer, ["push", "--quiet", "origin", "main"]);

    const accepted = await syncGitStore(store, {
      branch: "main",
      acceptRemote: review.reviewCommit!,
    });

    expect(accepted.remoteChangesPending).toBe(true);
    expect(accepted.reviewCommit).not.toBe(review.reviewCommit);
    expect(await readFile(join(store, "reviewed.md"), "utf8")).toBe("reviewed\n");
    await expect(readFile(join(store, "unreviewed.md"), "utf8")).rejects.toThrow();
  });

  it("rejects an available local commit that was never fetched from the remote branch", async () => {
    const root = await makeTempRoot();
    const remote = join(root, "personal-store.git");
    const store = join(root, "store");
    await mkdir(remote);
    git(remote, ["init", "--quiet", "--bare"]);
    await initStoreGit(store, "main");
    configureIdentity(store);
    await writeFile(join(store, "harness.yaml"), "schemaVersion: 1\n", "utf8");
    await connectRemote(store, remote);
    await syncGitStore(store, { branch: "main", commitMessage: "base", push: true });
    const base = git(store, ["rev-parse", "HEAD"]);

    git(store, ["switch", "--quiet", "--create", "local-side-branch"]);
    await writeFile(join(store, "rogue.md"), "local side commit\n", "utf8");
    git(store, ["add", "--all", "--", "."]);
    git(store, ["commit", "--quiet", "--message", "local side commit"]);
    const localOnly = git(store, ["rev-parse", "HEAD"]);
    git(store, ["switch", "--quiet", "main"]);

    await expect(
      syncGitStore(store, {
        branch: "main",
        acceptRemote: localOnly,
        push: true,
      }),
    ).rejects.toThrow(/not reachable from the freshly fetched/u);
    expect(git(store, ["rev-parse", "HEAD"])).toBe(base);
    expect(git(remote, ["rev-parse", "refs/heads/main"])).toBe(base);
  });

  it("rejects runtime paths in a reviewed commit before changing HEAD or local state", async () => {
    const root = await makeTempRoot();
    const remote = join(root, "personal-store.git");
    const store = join(root, "store");
    const peer = join(root, "peer");
    await mkdir(remote);
    git(remote, ["init", "--quiet", "--bare"]);
    await initStoreGit(store, "main");
    configureIdentity(store);
    await writeFile(join(store, ".gitignore"), "/.state.json\n", "utf8");
    await writeFile(join(store, "harness.yaml"), "schemaVersion: 1\n", "utf8");
    await connectRemote(store, remote);
    await syncGitStore(store, { branch: "main", commitMessage: "base", push: true });
    const before = git(store, ["rev-parse", "HEAD"]);
    await writeFile(join(store, ".state.json"), '{"revision":"local"}\n', "utf8");
    git(root, ["clone", "--quiet", "--branch", "main", remote, peer]);
    configureIdentity(peer);
    await writeFile(join(peer, ".state.json"), '{"revision":"remote"}\n', "utf8");
    git(peer, ["add", "--force", "--", ".state.json"]);
    git(peer, ["commit", "--quiet", "--message", "bad runtime"]);
    git(peer, ["push", "--quiet", "origin", "main"]);
    const review = await syncGitStore(store, { branch: "main" });

    await expect(syncGitStore(store, {
      branch: "main",
      acceptRemote: review.reviewCommit!,
    })).rejects.toThrow(/was not integrated/u);
    expect(git(store, ["rev-parse", "HEAD"])).toBe(before);
    expect(await readFile(join(store, ".state.json"), "utf8"))
      .toBe('{"revision":"local"}\n');
  });

  it("refuses to sync runtime state even when it was previously tracked", async () => {
    const root = await makeTempRoot();
    const store = join(root, "store");
    await initStoreGit(store, "main");
    configureIdentity(store);
    await writeFile(join(store, "harness.yaml"), "schemaVersion: 1\n", "utf8");
    await writeFile(join(store, ".state.json"), '{"secret":"local"}\n', "utf8");
    git(store, ["add", "--all", "--", "."]);
    git(store, ["commit", "--quiet", "--message", "bad historical state"]);

    await expect(syncGitStore(store, { branch: "main" })).rejects.toThrow(
      /runtime\/private paths are tracked/u,
    );
  });

  it("rejects case-variant runtime aliases that are already tracked", async () => {
    const root = await makeTempRoot();
    const store = join(root, "store");
    await initStoreGit(store, "main");
    configureIdentity(store);
    await writeFile(join(store, "harness.yaml"), "schemaVersion: 1\n", "utf8");
    await writeFile(join(store, ".State.json"), '{"secret":"local"}\n', "utf8");
    git(store, ["add", "--all", "--", "."]);
    git(store, ["commit", "--quiet", "--message", "bad case alias"]);

    await expect(syncGitStore(store, { branch: "main" })).rejects.toThrow(
      /runtime\/private paths are tracked/u,
    );
  });

  it.each(["backups", ".state.json/child"])(
    "rejects a reserved runtime root or descendant tracked as %s",
    async (runtimePath) => {
      const root = await makeTempRoot();
      const store = join(root, "store");
      await initStoreGit(store, "main");
      configureIdentity(store);
      await writeFile(join(store, "harness.yaml"), "schemaVersion: 1\n", "utf8");
      await mkdir(join(store, runtimePath, ".."), { recursive: true });
      await writeFile(join(store, runtimePath), "runtime\n", "utf8");
      git(store, ["add", "--force", "--", runtimePath]);
      git(store, ["commit", "--quiet", "--message", "bad runtime shape"]);

      await expect(syncGitStore(store, { branch: "main" })).rejects.toThrow(
        /runtime\/private paths are tracked/u,
      );
    },
  );

  it("stages a fresh store while a live ignored lock file exists", async () => {
    const root = await makeTempRoot();
    const store = join(root, "store");
    await initStoreGit(store, "main");
    configureIdentity(store);
    await writeFile(join(store, ".gitignore"), ".lock\n", "utf8");
    await writeFile(join(store, ".lock"), "123:test\n", "utf8");
    await writeFile(join(store, "harness.yaml"), "schemaVersion: 1\n", "utf8");

    const result = await syncGitStore(store, { branch: "main" });

    expect(result.committed).toBe(true);
    expect(git(store, ["ls-files", ".lock"])).toBe("");
  });

  it("force-stages required canonical artifacts despite broad user ignore rules", async () => {
    const root = await makeTempRoot();
    const store = join(root, "store");
    await initStoreGit(store, "main");
    configureIdentity(store);
    await mkdir(join(store, "skills", "demo", "backups"), { recursive: true });
    await writeFile(join(store, ".gitignore"), "*.md\nbackups/\n", "utf8");
    await writeFile(join(store, "harness.yaml"), "schemaVersion: 1\n", "utf8");
    await writeFile(join(store, "skills", "demo", "SKILL.md"), "Skill\n", "utf8");
    await writeFile(
      join(store, "skills", "demo", "backups", "required.txt"),
      "Required asset\n",
      "utf8",
    );

    await syncGitStore(store, {
      branch: "main",
      requiredPaths: ["harness.yaml", "skills/demo"],
    });

    expect(git(store, ["ls-files", "skills/demo/SKILL.md"]))
      .toBe("skills/demo/SKILL.md");
    expect(git(store, ["ls-files", "skills/demo/backups/required.txt"]))
      .toBe("skills/demo/backups/required.txt");
  });

  it("rolls back a conflicted rebase without resetting the local commit", async () => {
    const root = await makeTempRoot();
    const remote = join(root, "personal-store.git");
    const store = join(root, "store");
    const peer = join(root, "peer");
    await mkdir(remote);
    git(remote, ["init", "--quiet", "--bare"]);
    await initStoreGit(store, "main");
    configureIdentity(store);
    await writeFile(join(store, "shared.md"), "base\n", "utf8");
    await connectRemote(store, remote);
    await syncGitStore(store, { branch: "main", commitMessage: "base", push: true });

    git(root, ["clone", "--quiet", "--branch", "main", remote, peer]);
    configureIdentity(peer);
    await writeFile(join(peer, "shared.md"), "peer\n", "utf8");
    git(peer, ["add", "--all", "--", "."]);
    git(peer, ["commit", "--quiet", "--message", "peer conflict"]);
    git(peer, ["push", "--quiet", "origin", "main"]);
    await writeFile(join(store, "shared.md"), "local\n", "utf8");

    const review = await syncGitStore(store, {
      branch: "main",
      commitMessage: "local conflict",
    });

    await expect(
      syncGitStore(store, {
        branch: "main",
        push: true,
        acceptRemote: review.reviewCommit!,
      }),
    ).rejects.toThrow(/rolled back/u);

    expect(await readFile(join(store, "shared.md"), "utf8")).toBe("local\n");
    expect(git(store, ["log", "-1", "--pretty=%s"])).toBe("local conflict");
    expect((await getGitStatus(store)).clean).toBe(true);
  });

  it("fast-forwards an empty local store from an existing remote", async () => {
    const root = await makeTempRoot();
    const remote = join(root, "personal-store.git");
    const source = join(root, "source");
    const store = join(root, "empty-store");
    await mkdir(remote);
    git(remote, ["init", "--quiet", "--bare"]);
    await initStoreGit(source, "main");
    configureIdentity(source);
    await writeFile(join(source, "harness.yaml"), "metadata:\n  name: shared\n", "utf8");
    await connectRemote(source, remote);
    await syncGitStore(source, { branch: "main", commitMessage: "seed", push: true });

    await initStoreGit(store, "main");
    configureIdentity(store);
    await connectRemote(store, remote);
    const review = await syncGitStore(store, { branch: "main" });
    const result = await syncGitStore(store, {
      branch: "main",
      acceptRemote: review.reviewCommit!,
    });

    expect(result).toMatchObject({
      committed: false,
      fetched: true,
      fastForwarded: true,
      pushed: false,
    });
    expect(await readFile(join(store, "harness.yaml"), "utf8")).toContain("name: shared");
    expect((await getGitStatus(store)).clean).toBe(true);
  });

  it("rejects HTTP remotes with embedded credentials before Git persists them", async () => {
    const root = await makeTempRoot();
    const store = join(root, "store");
    const secret = "never-print-this-token";
    const url = `https://git-user:${secret}@127.0.0.1:1/private.git`;
    await initStoreGit(store, "main");
    configureIdentity(store);
    await expect(connectRemote(store, url)).rejects.toThrow(
      /embedded credentials/u,
    );
    expect(git(store, ["remote"])).toBe("");
  });

  it("rejects credential-like HTTP remote query parameters", async () => {
    const root = await makeTempRoot();
    const store = join(root, "store");
    await initStoreGit(store, "main");

    await expect(
      connectRemote(store, "https://example.invalid/repo.git?access_token=secret"),
    ).rejects.toThrow(/query parameters/u);
    expect(git(store, ["remote"])).toBe("");
  });
});

describe.skipIf(!GIT_AVAILABLE)("carried files in the Git store", () => {
  /** A store with a remote and one committed carried plist. */
  async function seed() {
    const root = await makeTempRoot();
    const remote = join(root, "personal-store.git");
    const store = join(root, "store");
    const peer = join(root, "peer");
    await mkdir(remote);
    git(remote, ["init", "--quiet", "--bare"]);
    await initStoreGit(store, "main");
    configureIdentity(store);
    await writeFile(join(store, "harness.yaml"), "schemaVersion: 1\n", "utf8");
    await mkdir(join(store, "carry", "launch-agents"), { recursive: true });
    await writeFile(join(store, "carry", "launch-agents", "com.example.only.plist"), "<plist/>\n", "utf8");
    await connectRemote(store, remote);
    await syncGitStore(store, { branch: "main", commitMessage: "base", push: true });
    return { root, remote, store, peer };
  }

  it("stages a carried file through the ordinary pass, with no requiredPaths entry", async () => {
    // The whole reason carry is NOT in canonicalGitPaths: requiredPaths exists
    // to defeat .gitignore, and carry/ is not ignored.
    const { store } = await seed();
    await writeFile(join(store, "carry", "launch-agents", "com.example.new.plist"), "<plist/>\n", "utf8");
    await chmod(join(store, "carry", "launch-agents", "com.example.new.plist"), 0o755);

    const result = await syncGitStore(store, { branch: "main", commitMessage: "carry" });

    expect(result.committed).toBe(true);
    const listed = git(store, ["ls-files", "-s", "--", "carry"]);
    expect(listed).toContain("carry/launch-agents/com.example.new.plist");
    // The executable bit survives, which is invisible in a content diff.
    expect(listed).toMatch(/100755 \S+ 0\s+carry\/launch-agents\/com\.example\.new\.plist/u);
  });

  it("CANARY: force-staging an absent carry path aborts the whole chunk, harness.yaml included", async () => {
    // This is the measurement that kept carry OUT of requiredPaths. `git add
    // --force` exits 128 on a path that matches nothing and stages nothing at
    // all — so backupCanonicalStore would throw on every run, and the daemon's
    // backup timer discards that by design. Backups stop, silently.
    const { store } = await seed();
    await writeFile(join(store, "harness.yaml"), "schemaVersion: 1\n# edited\n", "utf8");
    git(store, ["reset", "--quiet"]);

    const result = spawnSync(
      "git",
      ["add", "--force", "--", "./harness.yaml", "./carry/does-not-exist"],
      { cwd: store, encoding: "utf8", shell: false },
    );

    expect(result.status).toBe(128);
    expect(git(store, ["diff", "--cached", "--name-only"])).toBe("");
  });

  it("refuses a reviewed commit that drops a carried file", async () => {
    const { root, remote, store, peer } = await seed();
    git(root, ["clone", "--quiet", "--branch", "main", remote, peer]);
    configureIdentity(peer);
    git(peer, ["rm", "--quiet", "--", "carry/launch-agents/com.example.only.plist"]);
    git(peer, ["commit", "--quiet", "--message", "drop the carried plist"]);
    git(peer, ["push", "--quiet", "origin", "main"]);
    const review = await syncGitStore(store, { branch: "main" });

    await expect(syncGitStore(store, {
      branch: "main",
      acceptRemote: review.reviewCommit!,
      protectedPathPrefixes: ["carry"],
    })).rejects.toThrow(/may be their only copy/u);

    // CANARY: without the refusal, `read-tree -m -u` exits 0 and the file is
    // simply gone from the worktree, after update-ref has moved the branch.
    expect(await readFile(join(store, "carry", "launch-agents", "com.example.only.plist"), "utf8"))
      .toBe("<plist/>\n");
  });

  it("proceeds once the removal is explicitly allowed", async () => {
    const { root, remote, store, peer } = await seed();
    git(root, ["clone", "--quiet", "--branch", "main", remote, peer]);
    configureIdentity(peer);
    git(peer, ["rm", "--quiet", "--", "carry/launch-agents/com.example.only.plist"]);
    git(peer, ["commit", "--quiet", "--message", "drop the carried plist"]);
    git(peer, ["push", "--quiet", "origin", "main"]);
    const review = await syncGitStore(store, { branch: "main" });

    await syncGitStore(store, {
      branch: "main",
      acceptRemote: review.reviewCommit!,
      protectedPathPrefixes: ["carry"],
      allowProtectedRemoval: true,
    });

    expect(git(store, ["ls-files", "--", "carry"])).toBe("");
  });
});

async function makeTempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "harness-sync-git-"));
  tempRoots.push(root);
  return root;
}

function configureIdentity(repository: string): void {
  git(repository, ["config", "user.name", "Harness Sync Test"]);
  git(repository, ["config", "user.email", "harness-sync@example.invalid"]);
}

function git(cwd: string, args: string[]): string {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: "0",
      GCM_INTERACTIVE: "Never",
    },
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout || `git exited ${String(result.status)}`);
  }
  return result.stdout.trim();
}

describe("scheduled store backup", () => {
  it("commits the store from inside the daemon, which holds the lock", async () => {
    const root = await mkdtemp(join(tmpdir(), "harness-sync-daemon-backup-"));
    tempRoots.push(root);
    await writeFile(join(root, "CLAUDE.md"), "# Instructions\n", "utf8");
    const project = await initializeProject(root);
    await initStoreGit(project.storeDir, "main");

    // The reason this lives in the daemon at all: it holds the store lock for
    // its whole lifetime, so anything external calling `git sync` is refused.
    const release = await acquireLock(join(project.storeDir, ".lock"));
    try {
      await expect(
        backupCanonicalStore(project, { push: false, message: "scheduled" }),
      ).resolves.toBeTruthy();
    } finally {
      await release();
    }

    const log = spawnSync("git", ["-C", project.storeDir, "log", "--oneline"], {
      encoding: "utf8",
    });
    expect(log.stdout).toContain("scheduled");
  });

  it("refuses a scheduled backup that would commit a secret", async () => {
    const root = await mkdtemp(join(tmpdir(), "harness-sync-daemon-secret-"));
    tempRoots.push(root);
    await writeFile(join(root, "CLAUDE.md"), "# Instructions\n", "utf8");
    const project = await initializeProject(root);
    await initStoreGit(project.storeDir, "main");
    await mkdir(join(project.storeDir, "skills", "leaky"), { recursive: true });
    await writeFile(
      join(project.storeDir, "skills", "leaky", "SKILL.md"),
      "---\nname: leaky\ndescription: x\n---\nexport TOKEN=ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n",
      "utf8",
    );
    const harness = await loadHarness(project.storeDir);
    harness.skills = [{ name: "leaky", path: "skills/leaky" }];
    await writeHarness(project.storeDir, harness);

    // A scheduled backup must not be a way around a gate the interactive
    // command enforces.
    await expect(backupCanonicalStore(project, { push: false })).rejects.toThrow(
      /Secret scan blocked/u,
    );
  });
});
