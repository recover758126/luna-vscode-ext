import { ChildProcessWithoutNullStreams, spawn } from "child_process";
import * as path from "path";
import * as fs from "fs";

export interface ClaudeBinary {
  pathToClaudeCodeExecutable: string;
  env: Record<string, string | undefined>;
}

export interface SpawnOptions {
  binaryPath: string;
  cwd: string;
  env?: Record<string, string | undefined>;
  args?: string[];
}

export function resolveClaudeBinary(preferredPath?: string): ClaudeBinary {
  const env: Record<string, string | undefined> = { ...process.env };

  if (preferredPath && fs.existsSync(preferredPath)) {
    return { pathToClaudeCodeExecutable: preferredPath, env };
  }

  // Default: look for the VSIX's bundled native binary in the extension dir.
  const candidates = [
    path.join(__dirname, "..", "resources", "native-binary", "claude"),
    path.join(__dirname, "resources", "native-binary", "claude"),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) {
      return { pathToClaudeCodeExecutable: c, env };
    }
  }

  // Fall back to a `claude` resolved from PATH.
  return { pathToClaudeCodeExecutable: "claude", env };
}

/**
 * Spawns the bundled claude binary in --print-mode streaming JSON-over-stdio
 * mode. This mirrors how the official extension launches the runtime: it
 * writes JSON control messages to the child's stdin and reads JSON messages
 * (control_request / control_response / result / assistant / ...)
 * from its stdout, newline-delimited.
 *
 * The default flag set below is the one used by the official extension's
 * `query()` SDK entrypoint (stream-json, input-format stream-json).
 */
export function spawnClaudeBinary(
  opts: SpawnOptions
): ChildProcessWithoutNullStreams {
  const binary = opts.binaryPath;
  const args = [
    ...(opts.args ?? []),
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    "--verbose",
    "--include-partial-messages",
  ];
  const child = spawn(binary, args, {
    cwd: opts.cwd,
    env: { ...opts.env } as NodeJS.ProcessEnv,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: false,
  });
  return child;
}