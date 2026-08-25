import { execFile } from "node:child_process";
import { tool } from "ai";
import { z } from "zod";

/**
 * Project files shell tool.
 *
 * Runs a bash command with the project's shared file directory as the
 * working directory. On project runtimes that directory is the S3 Files
 * access point mounted at /mnt/files (PROJECT_FILES_DIR), scoped to
 * projects/{id}/ in the artifacts bucket — the same files the project's
 * Files tab shows. Standard unix tools (ls, cat, grep, sed, mkdir, mv,
 * redirection, heredocs) cover browsing, reading, and writing, so this one
 * tool replaces a whole family of bespoke file tools.
 *
 * Containment notes:
 * - Which files are reachable is decided by the MOUNT (per-project access
 *   point), not by this tool — commands can leave the cwd but there is no
 *   other project's data anywhere in the container.
 * - The child process gets a scrubbed environment: the worker's process.env
 *   holds live credentials (Aurora, resolved at boot), which must not leak
 *   into `env` output.
 * - When PROJECT_FILES_DIR is unset (task-based agents, local dev, runs on
 *   the shared runtime) the tool returns a structured error instead of
 *   touching the container file system.
 */

const NAME = "project-files-shell" as const;

/** Per-stream cap on what is returned to the model. */
const OUTPUT_CAP_CHARS = 20_000;

/** Hard cap on what we buffer from the child at all. */
const MAX_BUFFER_BYTES = 4 * 1024 * 1024;

function clip(text: string): { text: string; truncated: boolean } {
  if (text.length <= OUTPUT_CAP_CHARS) return { text, truncated: false };
  return {
    text: `${text.slice(0, OUTPUT_CAP_CHARS)}\n… [truncated: output exceeded ${OUTPUT_CAP_CHARS} characters]`,
    truncated: true,
  };
}

export const projectFilesShell = tool({
  description:
    "Run a bash command in the project's shared file directory (the working directory). Every agent in this project reads and writes the same directory, and it is the same file tree the project's Files tab shows — files you write here are visible to teammates and the user, and persist across runs. Use standard unix tools: `ls -la`, `cat notes.md`, `grep -rn term .`, `mkdir -p results`, `cat > results/summary.md <<'EOF' … EOF`. Prefer relative paths. Keep output small (head/tail/grep) — large output is truncated. Not available outside a project context.",
  inputSchema: z.object({
    command: z
      .string()
      .min(1)
      .describe(
        "The bash command to run (passed to `bash -c`) with the project files directory as the working directory.",
      ),
    timeoutSeconds: z
      .number()
      .int()
      .min(1)
      .max(120)
      .default(30)
      .describe("Kill the command after this many seconds (default 30)."),
  }),
  execute: ({ command, timeoutSeconds }) => {
    const filesDir = process.env.PROJECT_FILES_DIR;
    if (!filesDir) {
      return Promise.resolve({
        type: NAME,
        command,
        error:
          "The project file system is not available in this context (no PROJECT_FILES_DIR). This tool only works for agents running inside a project.",
      });
    }

    return new Promise((resolve) => {
      execFile(
        "/bin/bash",
        ["-c", command],
        {
          cwd: filesDir,
          timeout: timeoutSeconds * 1000,
          killSignal: "SIGKILL",
          maxBuffer: MAX_BUFFER_BYTES,
          // Scrubbed environment — never inherit the worker's process.env
          // (it holds live DB credentials resolved at boot).
          env: {
            PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
            HOME: filesDir,
            LANG: "C.UTF-8",
            PROJECT_FILES_DIR: filesDir,
          },
        },
        (error, stdout, stderr) => {
          const out = clip(stdout ?? "");
          const err = clip(stderr ?? "");

          // execFile "errors" on non-zero exit, timeout, and maxBuffer
          // overflow alike; distinguish them for the model.
          const killed = Boolean(error && "killed" in error && error.killed);
          const code =
            error && typeof (error as { code?: unknown }).code === "number"
              ? ((error as { code: number }).code as number)
              : error
                ? null
                : 0;

          resolve({
            type: NAME,
            command,
            exitCode: code,
            stdout: out.text,
            stderr: err.text,
            ...(out.truncated || err.truncated ? { truncated: true } : {}),
            ...(killed
              ? {
                  error: `Command killed after ${timeoutSeconds}s timeout (or output exceeded the buffer cap).`,
                }
              : code !== 0 && code !== null
                ? { error: `Command exited with status ${code}.` }
                : error && code === null
                  ? { error: error.message }
                  : {}),
          });
        },
      );
    });
  },
});
