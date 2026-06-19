import { execFile, spawn, ChildProcess } from "child_process";
import { promisify } from "util";
import fs from "fs/promises";
import path from "path";
import os from "os";
import { ToolError } from "../types.js";

const execFileAsync = promisify(execFile);

// ─── Path Utilities ───────────────────────────────────────────────────────────

/**
 * Expand ~ and %USERPROFILE% in paths to absolute paths.
 */
export function expandPath(inputPath: string): string {
  if (inputPath.startsWith("~")) {
    return path.join(os.homedir(), inputPath.slice(1));
  }
  if (inputPath.startsWith("%USERPROFILE%")) {
    const home = process.env.USERPROFILE ?? os.homedir();
    return path.join(home, inputPath.slice("%USERPROFILE%".length));
  }
  return inputPath;
}

/**
 * Default roots a user-supplied path is allowed to resolve under. We accept:
 *   - the user's home directory (covers `~/WSO2Integrator`)
 *   - the OS tmp directory
 *   - any directory the user has whitelisted via SF_MCP_ALLOWED_ROOTS (`:` separated)
 *
 * This is the containment check that protects us from `../../etc` style inputs.
 */
function allowedRoots(): string[] {
  const extras = (process.env.SF_MCP_ALLOWED_ROOTS ?? "")
    .split(path.delimiter)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => path.resolve(expandPath(p)));
  return [path.resolve(os.homedir()), path.resolve(os.tmpdir()), ...extras];
}

/**
 * Resolve and verify that `inputPath` lies under one of the allowed roots.
 * Throws ToolError(PATH_TRAVERSAL) on violation.
 */
export function safeResolve(inputPath: string): string {
  const abs = path.resolve(expandPath(inputPath));
  const roots = allowedRoots();
  const ok = roots.some((root) => abs === root || abs.startsWith(root + path.sep));
  if (!ok) {
    throw new ToolError(
      "PATH_TRAVERSAL",
      `Refusing to operate on path '${abs}': not under an allowed root.`,
      `Allowed roots: ${roots.join(", ")}. ` +
        `Add more via SF_MCP_ALLOWED_ROOTS env var (':'-separated).`
    );
  }
  return abs;
}

/**
 * Resolve `child` relative to `parent` and verify the result stays inside
 * `parent`. Used for project-local file writes (Config.toml, types.bal, etc.).
 */
export function safeJoin(parent: string, child: string): string {
  const parentAbs = path.resolve(parent);
  const joined = path.resolve(parentAbs, child);
  if (joined !== parentAbs && !joined.startsWith(parentAbs + path.sep)) {
    throw new ToolError(
      "PATH_TRAVERSAL",
      `Refusing to write to '${joined}': escapes project root '${parentAbs}'.`
    );
  }
  return joined;
}

// ─── File Writers ─────────────────────────────────────────────────────────────

export interface WriteFileOpts {
  /** File mode (octal). Sensitive files (e.g. Config.toml) should pass 0o600. */
  mode?: number;
}

export async function writeFile(
  filePath: string,
  content: string,
  opts: WriteFileOpts = {}
): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content, { encoding: "utf-8", mode: opts.mode });
  if (opts.mode !== undefined) {
    // mode on writeFile is only honored on create. chmod ensures rotation
    // (rewriting an existing Config.toml) tightens perms even if it was 0644.
    try {
      await fs.chmod(filePath, opts.mode);
    } catch {
      /* best-effort; Windows lacks POSIX modes */
    }
  }
}

/**
 * Convenience wrapper for credential files (Config.toml). Writes with 0600
 * so only the owning user can read the secrets.
 */
export async function writeSecretFile(filePath: string, content: string): Promise<void> {
  await writeFile(filePath, content, { mode: 0o600 });
}

export async function directoryExists(dirPath: string): Promise<boolean> {
  try {
    const stat = await fs.stat(dirPath);
    return stat.isDirectory();
  } catch {
    return false;
  }
}

export async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

// ─── Ballerina CLI Wrappers ───────────────────────────────────────────────────

/**
 * Resolve the `bal` executable. Honors `BAL_BIN` env var so users on systems
 * where `bal` isn't on PATH (or who use bvm) can pin a specific binary.
 */
function balBin(): string {
  return process.env.BAL_BIN || "bal";
}

export async function balBuild(
  projectPath: string
): Promise<{ output: string; success: boolean }> {
  try {
    const { stdout, stderr } = await execFileAsync(balBin(), ["build"], {
      cwd: projectPath,
      timeout: 120_000,
      env: { ...process.env },
    });
    return { output: `${stdout}\n${stderr}`.trim(), success: true };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { output: msg, success: false };
  }
}

/**
 * Tracks live `bal run` children spawned by this process so users can stop
 * them via the `sf_stop_project` tool. Keyed by PID.
 *
 * Stores both the ChildProcess and the project path so listLiveBalRuns()
 * can report where each process was started from.
 */
interface TrackedRun {
  proc: ChildProcess;
  projectPath: string;
}

const liveBalRuns = new Map<number, TrackedRun>();

export function listLiveBalRuns(): Array<{ pid: number; projectPath: string }> {
  return Array.from(liveBalRuns.entries()).map(([pid, { projectPath }]) => ({
    pid,
    projectPath,
  }));
}

export function stopBalRun(pid: number): { stopped: boolean; reason: string } {
  const tracked = liveBalRuns.get(pid);
  if (!tracked) {
    return {
      stopped: false,
      reason: `No tracked bal-run process with PID ${pid}. (Only processes started by sf_deploy_project are tracked.)`,
    };
  }
  const { proc } = tracked;
  try {
    // Negative PID kills the whole process group (bal forks worker processes).
    process.kill(-pid, "SIGTERM");
  } catch {
    try {
      proc.kill("SIGTERM");
    } catch (e) {
      return { stopped: false, reason: (e as Error).message };
    }
  }
  liveBalRuns.delete(pid);
  return { stopped: true, reason: `Sent SIGTERM to PID ${pid}.` };
}

/**
 * Spawn `bal run` in the background. Resolves when the listener has started,
 * the process exits early (failure), or the startup window elapses.
 */
export async function balRun(
  projectPath: string,
  port?: number
): Promise<{ pid: number | undefined; output: string; started: boolean }> {
  return new Promise((resolve) => {
    const args = ["run"];
    if (port !== undefined) {
      args.push(`-CservicePort=${port}`);
    }

    const proc = spawn(balBin(), args, {
      cwd: projectPath,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env },
    });

    if (proc.pid !== undefined) {
      liveBalRuns.set(proc.pid, { proc, projectPath });
    }

    let output = "";
    let settled = false;

    const settle = (result: { pid: number | undefined; output: string; started: boolean }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    proc.stdout?.on("data", (chunk: Buffer) => {
      output += chunk.toString();
      if (
        output.includes("Ballerina HTTP(S) listener started") ||
        output.includes("started HTTP/WS listener")
      ) {
        proc.unref();
        settle({ pid: proc.pid, output: output.trim(), started: true });
      }
    });

    proc.stderr?.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });

    proc.on("error", (err) => {
      if (proc.pid !== undefined) liveBalRuns.delete(proc.pid);
      settle({ pid: undefined, output: `Failed to start: ${err.message}`, started: false });
    });

    proc.on("exit", (code) => {
      if (proc.pid !== undefined) liveBalRuns.delete(proc.pid);
      proc.unref();
      if (!settled) {
        settle({
          pid: proc.pid,
          output: `${output.trim()}\n(process exited with code ${code ?? "unknown"})`,
          started: false,
        });
      }
    });

    // Fallback: resolve after 90s. `bal run` compiles before serving, which
    // can take 30-120s on a cold cache. We don't fail here — the process may
    // still come up. The caller checks the output for "(process exited with code"
    // to distinguish a real failure from a slow cold start.
    const timer = setTimeout(() => {
      proc.unref();
      settle({
        pid: proc.pid,
        output:
          output.trim() ||
          "Process started but startup banner not yet observed. " +
            "`bal run` compiles before serving — this is normal on first run. " +
            `Check http://localhost:${port ?? 9090}/health in ~30s.`,
        started: false,
      });
    }, 90_000);
  });
}

export interface BalCliInfo {
  available: boolean;
  version: string;
  /** True when the installed distribution matches the pinned BAL_DISTRIBUTION. */
  versionMatch: boolean;
  /** Human-readable warning when the distribution doesn't match, null otherwise. */
  versionWarning: string | null;
}

export async function checkBalCli(expectedDistribution?: string): Promise<BalCliInfo> {
  try {
    const { stdout } = await execFileAsync(balBin(), ["version"], { timeout: 10_000 });
    const version = stdout.trim();
    if (expectedDistribution) {
      const match = version.includes(expectedDistribution);
      return {
        available: true,
        version,
        versionMatch: match,
        versionWarning: match
          ? null
          : `Installed Ballerina distribution does not appear to match the required ${expectedDistribution}. ` +
            `Generated projects pin 'distribution = "${expectedDistribution}"' in Ballerina.toml — ` +
            `a mismatch may cause 'bal build' to fail. Download ${expectedDistribution} from https://ballerina.io/downloads/.`,
      };
    }
    return { available: true, version, versionMatch: true, versionWarning: null };
  } catch {
    return { available: false, version: "", versionMatch: false, versionWarning: null };
  }
}
