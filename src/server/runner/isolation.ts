import "server-only";

import { createHash, randomUUID } from "node:crypto";
import { statSync } from "node:fs";
import { chmod, copyFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { workerEnvelopeSchema, workerResultSchema, type WorkerEnvelope, type WorkerResult } from "@/shared/worker";
import { canonicalizeWorkspace, type CanonicalArtifact } from "@/server/artifacts/canonicalize";

export type IsolatedCallResult = {
  result: WorkerResult;
  artifact?: CanonicalArtifact;
  processId: number;
  workspaceFingerprint: string;
  inputHash: string;
  outputHash: string;
};

const inheritedEnvironmentKeys = [
  "PATH", "HOME", "USER", "LOGNAME", "LANG", "LC_ALL", "TMPDIR", "SHELL", "TERM",
  "SYSTEMROOT", "COMSPEC", "PATHEXT", "LOCALAPPDATA", "APPDATA",
];

function safeEnvironment(codexHome: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { CODEX_HOME: codexHome, NO_COLOR: "1", NODE_ENV: process.env.NODE_ENV };
  for (const key of inheritedEnvironmentKeys) {
    const value = process.env[key];
    if (value) env[key] = value;
  }
  if (process.env.WORDS_FAKE_CODEX === "1") env.WORDS_FAKE_CODEX = "1";
  if (process.env.WORDS_FAKE_CODEX === "1" && process.env.WORDS_FAKE_DELAY_MS) {
    env.WORDS_FAKE_DELAY_MS = process.env.WORDS_FAKE_DELAY_MS;
  }
  if (process.env.WORDS_EXTERNAL_SANDBOX === "1") env.WORDS_EXTERNAL_SANDBOX = "1";
  return env;
}

function authSourcePath(): string {
  const candidates = [
    process.env.CODEX_HOME ? path.join(process.env.CODEX_HOME, "auth.json") : null,
    path.join(os.homedir(), ".codex", "auth.json"),
  ].filter((candidate): candidate is string => Boolean(candidate));
  const source = candidates.find((candidate) => {
    try {
      return statSync(candidate).isFile();
    } catch {
      return false;
    }
  });
  return source ?? candidates[0];
}

async function prepareCodexHome(codexHome: string): Promise<void> {
  await mkdir(codexHome, { recursive: true, mode: 0o700 });
  if (process.env.WORDS_FAKE_CODEX === "1") return;
  const source = authSourcePath();
  try {
    const target = path.join(codexHome, "auth.json");
    await copyFile(source, target);
    await chmod(target, 0o600);
  } catch {
    throw new Error("No file-backed Codex sign-in was found. Run `codex login`, then retry the preflight.");
  }
}

export async function runIsolatedCall(
  envelopeInput: WorkerEnvelope,
  signal?: AbortSignal,
  onStart?: (metadata: { processId: number; workspaceFingerprint: string; inputHash: string }) => void,
): Promise<IsolatedCallResult> {
  const envelope = workerEnvelopeSchema.parse(envelopeInput);
  const root = await mkdtemp(path.join(os.tmpdir(), "words-meaning-"));
  const workspace = path.join(root, "workspace");
  const codexHome = path.join(root, "codex-home");
  const runtimeTemporary = path.join(root, "runtime-tmp");
  const serialized = JSON.stringify(envelope);
  const inputHash = createHash("sha256").update(serialized).digest("hex");
  const workspaceFingerprint = createHash("sha256").update(`${workspace}:${randomUUID()}`).digest("hex");
  await mkdir(workspace, { mode: 0o700 });
  await mkdir(runtimeTemporary, { mode: 0o700 });

  try {
    await prepareCodexHome(codexHome);
    const applicationRoot = process.cwd();
    const workerPath = path.join(applicationRoot, "src", "worker", "codex-call.ts");
    const externalSandbox = process.env.WORDS_EXTERNAL_SANDBOX === "1";
    const executable = externalSandbox
      ? "/usr/bin/sudo"
      : path.join(applicationRoot, "node_modules", ".bin", process.platform === "win32" ? "tsx.cmd" : "tsx");
    const arguments_ = externalSandbox ? [
      "-n", "/usr/bin/bwrap",
      "--unshare-pid", "--unshare-uts", "--unshare-ipc",
      "--die-with-parent", "--new-session",
      "--ro-bind", "/usr", "/usr",
      "--ro-bind", "/bin", "/bin",
      "--ro-bind", "/lib", "/lib",
      "--ro-bind", "/lib64", "/lib64",
      "--ro-bind", "/etc", "/etc",
      "--dir", "/run",
      "--dir", "/run/systemd",
      "--ro-bind", "/run/systemd/resolve", "/run/systemd/resolve",
      // The host's /etc/resolv.conf points at systemd-resolved's loopback stub.
      // That stub rejects lookups from the dropped uid in this mount namespace,
      // so expose the read-only upstream resolver list at the symlink target.
      "--ro-bind", "/run/systemd/resolve/resolv.conf", "/run/systemd/resolve/stub-resolv.conf",
      "--ro-bind", applicationRoot, "/runner",
      "--proc", "/proc", "--dev", "/dev",
      "--bind", workspace, "/workspace",
      "--bind", codexHome, "/codex-home",
      "--bind", runtimeTemporary, "/tmp",
      "--setenv", "HOME", "/workspace",
      "--setenv", "CODEX_HOME", "/codex-home",
      "--setenv", "PATH", "/usr/bin:/bin",
      "--setenv", "NODE_ENV", process.env.NODE_ENV,
      "--setenv", "NO_COLOR", "1",
      "--setenv", "WORDS_EXTERNAL_SANDBOX", "1",
      "--chdir", "/workspace",
      "/usr/bin/setpriv",
      "--reuid=1000", "--regid=1000", "--clear-groups",
      "--bounding-set=-all", "--inh-caps=-all", "--ambient-caps=-all",
      "/runner/node_modules/.bin/tsx", "/runner/src/worker/codex-call.ts",
    ] : [workerPath];
    const child = spawn(executable, arguments_, {
      cwd: externalSandbox ? applicationRoot : workspace,
      env: safeEnvironment(codexHome),
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      detached: process.platform !== "win32",
    });
    const processId = child.pid;
    if (!processId) throw new Error("Worker process did not start");
    onStart?.({ processId, workspaceFingerprint, inputHash });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      if (stdout.length > 4_000_000) child.kill("SIGKILL");
    });
    child.stderr.on("data", (chunk: string) => {
      stderr = `${stderr}${chunk}`.slice(-8_000);
    });
    child.stdin.end(serialized);
    const terminate = (signal: NodeJS.Signals) => {
      if (!child.pid) return;
      try {
        if (process.platform === "win32") child.kill(signal);
        else process.kill(-child.pid, signal);
      } catch {
        // The process group already exited.
      }
    };
    const timeout = setTimeout(() => terminate("SIGTERM"), 10 * 60_000);
    const abort = () => terminate("SIGTERM");
    signal?.addEventListener("abort", abort, { once: true });
    const exitCode = await new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", resolve);
    }).finally(() => {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abort);
    });
    if (signal?.aborted) throw new Error("Model call canceled");
    if (exitCode !== 0) throw new Error(stderr.trim() || `Worker exited with code ${exitCode}`);
    const result = workerResultSchema.parse(JSON.parse(stdout));
    let artifact: CanonicalArtifact | undefined;
    if (envelope.kind === "generate") {
      try {
        artifact = await canonicalizeWorkspace(workspace);
      } catch (error) {
        const reason = error instanceof Error ? error.message : "Artifact collection failed";
        const response = result.finalResponse.replace(/[\r\n]+/g, " ").slice(0, 600);
        throw new Error(`${reason}. Codex final response: ${response || "empty"}`);
      }
    }
    return {
      result,
      artifact,
      processId,
      workspaceFingerprint,
      inputHash,
      outputHash: createHash("sha256").update(stdout).digest("hex"),
    };
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 3 });
  }
}

export function isolationPreflight() {
  const source = authSourcePath();
  let authFilePresent = false;
  try {
    authFilePresent = statSync(source).isFile();
  } catch {
    authFilePresent = false;
  }
  return {
    ok: authFilePresent || process.env.WORDS_FAKE_CODEX === "1",
    authFilePresent,
    sdkVersion: "0.151.0",
    nodeVersion: process.version,
    controls: {
      childProcessPerCall: true,
      freshCodexHomePerCall: true,
      freshThreadPerCall: true,
      workspaceOutsideRepository: true,
      networkDisabled: process.env.WORDS_EXTERNAL_SANDBOX !== "1",
      externalMountSandbox: process.env.WORDS_EXTERNAL_SANDBOX === "1",
      approvalPolicy: "never",
    },
  };
}
