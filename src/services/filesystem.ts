import { execFile, spawn, ChildProcess } from "child_process";
import { createWriteStream } from "fs";
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
  logFile: string;
}

const liveBalRuns = new Map<number, TrackedRun>();

export function listLiveBalRuns(): Array<{ pid: number; projectPath: string; logFile: string }> {
  return Array.from(liveBalRuns.entries()).map(([pid, { projectPath, logFile }]) => ({
    pid,
    projectPath,
    logFile,
  }));
}

export async function getBalRunLog(pid: number, lines = 100): Promise<string> {
  const tracked = liveBalRuns.get(pid);
  const logFile = tracked?.logFile ?? path.join(os.tmpdir(), `bal-run-${pid}.log`);
  try {
    const content = await fs.readFile(logFile, "utf-8");
    const all = content.split("\n");
    return all.slice(-lines).join("\n");
  } catch {
    return `Log file not found: ${logFile}`;
  }
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
/**
 * Open a new terminal window and run `bal run` inside it, so logs are fully
 * visible to the user. On macOS we write a .command file and use `open` —
 * Terminal.app launches it automatically. On Linux we try common emulators.
 * Returns immediately; the terminal window runs independently.
 */
export async function openInTerminal(
  projectPath: string,
  port?: number
): Promise<{ opened: boolean; message: string }> {
  const portFlag = port !== undefined ? ` -- -CservicePort=${port}` : "";

  if (process.platform === "darwin") {
    // .command files are opened by Terminal.app on macOS when passed to `open`.
    // This avoids all AppleScript quoting issues.
    const tmpScript = path.join(os.tmpdir(), `bal-run-${Date.now()}.command`);
    await fs.writeFile(
      tmpScript,
      `#!/bin/bash\ncd ${JSON.stringify(projectPath)} && bal run${portFlag}\n`,
      { mode: 0o755 }
    );
    try {
      await execFileAsync("open", [tmpScript]);
      return {
        opened: true,
        message: `Opened Terminal.app — running 'bal run' in ${projectPath}. Press Ctrl+C in that window to stop.`,
      };
    } catch (err) {
      return { opened: false, message: `open failed: ${String(err)}` };
    }
  }

  if (process.platform === "linux") {
    const cmd = `cd ${JSON.stringify(projectPath)} && bal run${portFlag}`;
    const candidates: [string, string[]][] = [
      ["gnome-terminal", ["--", "bash", "-c", `${cmd}; exec bash`]],
      ["xterm", ["-e", `bash -c '${cmd}; exec bash'`]],
      ["konsole", ["-e", `bash -c '${cmd}; exec bash'`]],
    ];
    for (const [bin, args] of candidates) {
      try {
        spawn(bin, args, { detached: true, stdio: "ignore" }).unref();
        return { opened: true, message: `Opened ${bin} running 'bal run' in ${projectPath}.` };
      } catch { /* try next */ }
    }
    return { opened: false, message: "No terminal emulator found. Run 'bal run' manually." };
  }

  return {
    opened: false,
    message: `Platform '${process.platform}' not supported for terminal launch. Run 'cd ${projectPath} && bal run${portFlag}' manually.`,
  };
}

/**
 * Return the PIDs of every process currently bound to `port`.
 * Empty array means the port is free. Best-effort: relies on `lsof`, which
 * exits non-zero (→ empty) when nothing owns the port.
 */
export async function getPortHolders(port: number): Promise<number[]> {
  try {
    // lsof -ti:<port> prints PIDs of processes bound to the port, one per line.
    const { stdout } = await execFileAsync("lsof", ["-ti", `:${port}`]);
    return stdout
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .map(Number)
      .filter((n) => Number.isInteger(n));
  } catch {
    // lsof exits non-zero when no process owns the port — that's fine.
    return [];
  }
}

/**
 * Pre-flight a port before launching `bal run`. Distinguishes processes WE
 * started (tracked `bal run` children) from unknown processes:
 *
 *   - Free port            → returns { stoppedTracked: [] }.
 *   - Held by tracked runs → stops them (it's a stale run of our own service),
 *                            waits for the socket to release, returns their PIDs.
 *   - Held by an UNKNOWN   → throws PRECONDITION_FAILED rather than killing a
 *     process            process we don't own; the caller surfaces the PID and
 *                          remediation to the user.
 */
export async function ensurePortAvailable(
  port: number
): Promise<{ stoppedTracked: number[] }> {
  const holders = await getPortHolders(port);
  if (holders.length === 0) return { stoppedTracked: [] };

  const tracked = holders.filter((pid) => liveBalRuns.has(pid));
  const unknown = holders.filter((pid) => !liveBalRuns.has(pid));

  if (unknown.length > 0) {
    throw new ToolError(
      "PRECONDITION_FAILED",
      `Port ${port} is already in use by PID ${unknown.join(", ")} (not started by this server).`,
      `Stop that process first (e.g. 'kill ${unknown[0]}'), or choose a different port. ` +
        `If it's a 'bal run' you started in another terminal, press Ctrl+C there.`
    );
  }

  // Only our own stale runs hold the port — safe to reclaim.
  for (const pid of tracked) {
    stopBalRun(pid);
  }
  // Give the OS a moment to release the socket before rebinding.
  await new Promise((r) => setTimeout(r, 600));
  return { stoppedTracked: tracked };
}

export async function balRun(
  projectPath: string,
  port?: number
): Promise<{ pid: number | undefined; output: string; started: boolean; logFile: string }> {
  // NOTE: callers must pre-flight the port with ensurePortAvailable() before
  // calling this. We deliberately do NOT re-check here: stopBalRun() untracks a
  // PID the instant it signals it, so a second check during the OS's socket-
  // release window would misclassify our own dying run as an unknown process.
  const logFile = path.join(os.tmpdir(), `bal-run-${path.basename(projectPath)}-${Date.now()}.log`);
  const logStream = createWriteStream(logFile, { flags: "a" });

  return new Promise((resolve) => {
    const args = ["run"];
    if (port !== undefined) {
      // Configurable overrides must follow a `--` separator, per
      // `bal run [<package>] [-- -Ckey=value]`. Without it, bal treats
      // `-CservicePort=…` as a (nonexistent) package path and aborts.
      args.push("--", `-CservicePort=${port}`);
    }

    const proc = spawn(balBin(), args, {
      cwd: projectPath,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env },
    });

    if (proc.pid !== undefined) {
      liveBalRuns.set(proc.pid, { proc, projectPath, logFile });
    }

    let output = "";
    let settled = false;

    const settle = (result: { pid: number | undefined; output: string; started: boolean }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ...result, logFile });
    };

    const onChunk = (chunk: Buffer) => {
      const text = chunk.toString();
      output += text;
      logStream.write(text);
    };

    proc.stdout?.on("data", (chunk: Buffer) => {
      onChunk(chunk);
      if (
        output.includes("Ballerina HTTP(S) listener started") ||
        output.includes("started HTTP/WS listener")
      ) {
        proc.unref();
        settle({ pid: proc.pid, output: output.trim(), started: true });
      }
    });

    proc.stderr?.on("data", onChunk);

    proc.on("error", (err) => {
      if (proc.pid !== undefined) liveBalRuns.delete(proc.pid);
      settle({ pid: undefined, output: `Failed to start: ${err.message}`, started: false });
    });

    proc.on("exit", (code) => {
      if (proc.pid !== undefined) liveBalRuns.delete(proc.pid);
      logStream.end();
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
