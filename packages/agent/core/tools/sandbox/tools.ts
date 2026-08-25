import { tool } from "ai";
import { z } from "zod";
import {
  getActiveSession,
  invoke,
  startSession,
  stopSession,
} from "./client";
import { getTaskId } from "./context";

/**
 * Working directory inside the sandbox where the agent reads and writes files.
 *
 * This is an ordinary directory inside the Code Interpreter session — NOT a
 * mounted, persistent store. Files written here live only for the lifetime of
 * the session (≤60 minutes) and are lost when it stops or expires. It lives
 * under `/tmp` (world-writable) because the interpreter runs commands as an
 * unprivileged user that cannot create directories directly under `/`. It is a
 * concrete absolute path (no shell expansion) so the file tools, which pass
 * paths straight to the interpreter, resolve against it without a shell.
 */
export const WORKSPACE_PATH = "/tmp/workspace";

/**
 * AWS Bedrock AgentCore Code Interpreter sandbox tools.
 *
 * These let the agent spin up a per-task sandbox to generate and run code, or to
 * produce reports / PowerPoint / Word documents (e.g. via `python-pptx` /
 * `python-docx`). A task has at most one active session at a time and each
 * session expires 60 minutes after creation.
 *
 * Files live in the session's `WORKSPACE_PATH` (`/tmp/workspace`) directory and
 * are ephemeral: they exist only for the lifetime of the session and are lost
 * when it stops or expires. The file tools are confined to that directory.
 *
 * Every tool resolves the current task ID from `experimental_context` (set by
 * the agent loop) rather than taking it as input, and returns a discriminated
 * result object — returning an error object instead of throwing so the model can
 * react to failures.
 */

const NO_TASK_ERROR = {
  error: "No task context available for the sandbox session",
} as const;

const NO_SESSION_HINT =
  "No active sandbox session. Call createSandboxSession first.";

/**
 * Resolve a model-supplied path to an absolute path confined to
 * `WORKSPACE_PATH`. Accepts paths relative to the workspace (e.g. `report.pptx`,
 * `data/in.csv`) or already-absolute paths under it. Returns an error string for
 * anything that would escape the workspace (e.g. `../`, `/etc/passwd`).
 */
function resolveWorkspacePath(
  input: string,
): { ok: true; path: string } | { ok: false; error: string } {
  const trimmed = input.trim();
  const joined =
    trimmed.length === 0
      ? WORKSPACE_PATH
      : trimmed.startsWith("/")
        ? trimmed
        : `${WORKSPACE_PATH}/${trimmed}`;

  // Normalize away `.`/`..` segments so traversal can't escape the workspace.
  const segments: string[] = [];
  for (const segment of joined.split("/")) {
    if (segment === "" || segment === ".") {
      continue;
    }
    if (segment === "..") {
      if (segments.length === 0) {
        return {
          ok: false,
          error: `Path "${input}" escapes the ${WORKSPACE_PATH} workspace`,
        };
      }
      segments.pop();
      continue;
    }
    segments.push(segment);
  }

  const normalized = `/${segments.join("/")}`;
  if (
    normalized !== WORKSPACE_PATH &&
    !normalized.startsWith(`${WORKSPACE_PATH}/`)
  ) {
    return {
      ok: false,
      error: `Path "${input}" must be inside the ${WORKSPACE_PATH} workspace`,
    };
  }
  return { ok: true, path: normalized };
}

export const createSandboxSession = tool({
  description:
    `Start (or reuse) a secure code-execution sandbox for this task. Call this FIRST whenever the user wants you to generate or run code, or to produce a report, PowerPoint, or Word document. The sandbox is a managed Python/JavaScript/TypeScript environment with common libraries pre-installed. A task has at most one active session, which is reused on subsequent calls and expires 60 minutes after it is created. Read and write files under ${WORKSPACE_PATH}; note these files are ephemeral and exist only for the lifetime of the session. Returns the session id, expiry, and the workspace path.`,
  inputSchema: z.object({}),
  execute: async (_input, options) => {
    const taskId = getTaskId(options.experimental_context);
    if (!taskId) {
      return { type: "sandbox-session" as const, ...NO_TASK_ERROR };
    }

    try {
      const result = await startSession(taskId);

      // Ensure the workspace directory exists. It's a plain session-local dir
      // (not a mount); failure to create it shouldn't hide the session, so it's
      // reported softly rather than failing session creation.
      let workspaceReady = true;
      try {
        const mk = await invoke(taskId, "executeCommand", {
          command: `mkdir -p ${WORKSPACE_PATH}`,
        });
        workspaceReady = !mk.isError;
      } catch {
        workspaceReady = false;
      }

      return {
        type: "sandbox-session" as const,
        sessionId: result.sessionId,
        expiresAt: result.expiresAt.toISOString(),
        reused: result.reused,
        workspacePath: WORKSPACE_PATH,
        workspaceReady,
      };
    } catch (error) {
      return {
        type: "sandbox-session" as const,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  },
});

export const stopSandboxSession = tool({
  description:
    "Stop the active code-execution sandbox session for this task and release its resources. Use this when you are finished generating/running code or producing documents. Safe to call when no session is active.",
  inputSchema: z.object({}),
  execute: async (_input, options) => {
    const taskId = getTaskId(options.experimental_context);
    if (!taskId) {
      return { type: "sandbox-stop" as const, ...NO_TASK_ERROR };
    }

    try {
      const sessionId = await stopSession(taskId);
      return {
        type: "sandbox-stop" as const,
        stopped: sessionId !== null,
        sessionId,
      };
    } catch (error) {
      return {
        type: "sandbox-stop" as const,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  },
});

export const executeCode = tool({
  description:
    `Execute code in the task's sandbox session and return its output. Use this to run Python/JavaScript/TypeScript for calculations, data analysis, generating files (reports, PowerPoint via python-pptx, Word via python-docx), or validating results. Write any files you generate under ${WORKSPACE_PATH}. Requires an active session (call createSandboxSession first). State (variables, imported modules, files) persists across calls within the same session unless clearContext is set, but is lost when the session ends.`,
  inputSchema: z.object({
    language: z
      .enum(["python", "javascript", "typescript"])
      .default("python")
      .describe("The programming language of the code."),
    code: z.string().describe("The source code to execute."),
    clearContext: z
      .boolean()
      .optional()
      .describe("Reset the execution context before running this code."),
  }),
  execute: async ({ language, code, clearContext }, options) => {
    const taskId = getTaskId(options.experimental_context);
    if (!taskId) {
      return { type: "sandbox-execute-code" as const, ...NO_TASK_ERROR };
    }

    try {
      if (!(await getActiveSession(taskId))) {
        return { type: "sandbox-execute-code" as const, error: NO_SESSION_HINT };
      }
      const result = await invoke(taskId, "executeCode", {
        language,
        code,
        ...(clearContext !== undefined ? { clearContext } : {}),
      });
      return {
        type: "sandbox-execute-code" as const,
        output: result.text,
        isError: result.isError,
        exitCode: result.exitCode,
        stderr: result.stderr,
      };
    } catch (error) {
      return {
        type: "sandbox-execute-code" as const,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  },
});

export const executeCommand = tool({
  description:
    `Run a shell command in the task's sandbox session and return its output. Use this for tasks like installing extra Python packages (e.g. \`pip install python-pptx python-docx\`), inspecting the filesystem, or running CLI tools. The session working directory is ${WORKSPACE_PATH} (files there are ephemeral). Requires an active session (call createSandboxSession first).`,
  inputSchema: z.object({
    command: z.string().describe("The shell command to execute."),
  }),
  execute: async ({ command }, options) => {
    const taskId = getTaskId(options.experimental_context);
    if (!taskId) {
      return { type: "sandbox-execute-command" as const, ...NO_TASK_ERROR };
    }

    try {
      if (!(await getActiveSession(taskId))) {
        return {
          type: "sandbox-execute-command" as const,
          error: NO_SESSION_HINT,
        };
      }
      const result = await invoke(taskId, "executeCommand", { command });
      return {
        type: "sandbox-execute-command" as const,
        output: result.text,
        isError: result.isError,
        exitCode: result.exitCode,
        stderr: result.stderr,
      };
    } catch (error) {
      return {
        type: "sandbox-execute-command" as const,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  },
});

export const writeFiles = tool({
  description:
    `Write one or more text files into the sandbox workspace at ${WORKSPACE_PATH}. All paths are relative to ${WORKSPACE_PATH} (or must be absolute paths under ${WORKSPACE_PATH}). Files written here are ephemeral — they exist only for the lifetime of the session. Requires an active session (call createSandboxSession first).`,
  inputSchema: z.object({
    files: z
      .array(
        z.object({
          path: z
            .string()
            .describe(`Path under ${WORKSPACE_PATH} to write (relative or absolute).`),
          text: z.string().describe("UTF-8 text content of the file."),
        }),
      )
      .min(1)
      .describe("The files to write."),
  }),
  execute: async ({ files }, options) => {
    const taskId = getTaskId(options.experimental_context);
    if (!taskId) {
      return { type: "sandbox-write-files" as const, ...NO_TASK_ERROR };
    }

    try {
      if (!(await getActiveSession(taskId))) {
        return { type: "sandbox-write-files" as const, error: NO_SESSION_HINT };
      }

      const content: { path: string; text: string }[] = [];
      for (const file of files) {
        const resolved = resolveWorkspacePath(file.path);
        if (!resolved.ok) {
          return { type: "sandbox-write-files" as const, error: resolved.error };
        }
        content.push({ path: resolved.path, text: file.text });
      }

      const result = await invoke(taskId, "writeFiles", { content });
      return {
        type: "sandbox-write-files" as const,
        output: result.text,
        isError: result.isError,
        paths: content.map((c) => c.path),
      };
    } catch (error) {
      return {
        type: "sandbox-write-files" as const,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  },
});

export const readFiles = tool({
  description:
    `Read the contents of one or more files from the sandbox workspace at ${WORKSPACE_PATH} and return them inline. All paths are relative to ${WORKSPACE_PATH} (or absolute paths under ${WORKSPACE_PATH}). Requires an active session (call createSandboxSession first).`,
  inputSchema: z.object({
    paths: z
      .array(z.string())
      .min(1)
      .describe(`Paths under ${WORKSPACE_PATH} to read (relative or absolute).`),
  }),
  execute: async ({ paths }, options) => {
    const taskId = getTaskId(options.experimental_context);
    if (!taskId) {
      return { type: "sandbox-read-files" as const, ...NO_TASK_ERROR };
    }

    try {
      if (!(await getActiveSession(taskId))) {
        return { type: "sandbox-read-files" as const, error: NO_SESSION_HINT };
      }

      const resolvedPaths: string[] = [];
      for (const path of paths) {
        const resolved = resolveWorkspacePath(path);
        if (!resolved.ok) {
          return { type: "sandbox-read-files" as const, error: resolved.error };
        }
        resolvedPaths.push(resolved.path);
      }

      const result = await invoke(taskId, "readFiles", { paths: resolvedPaths });
      return {
        type: "sandbox-read-files" as const,
        content: result.text,
        isError: result.isError,
        paths: resolvedPaths,
      };
    } catch (error) {
      return {
        type: "sandbox-read-files" as const,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  },
});

export const listFiles = tool({
  description:
    `List files in a directory of the sandbox workspace at ${WORKSPACE_PATH}. Use this to discover generated files. The path is relative to ${WORKSPACE_PATH} (defaults to the workspace root). Requires an active session (call createSandboxSession first).`,
  inputSchema: z.object({
    directoryPath: z
      .string()
      .default("")
      .describe(`Directory under ${WORKSPACE_PATH} to list (relative or absolute).`),
  }),
  execute: async ({ directoryPath }, options) => {
    const taskId = getTaskId(options.experimental_context);
    if (!taskId) {
      return { type: "sandbox-list-files" as const, ...NO_TASK_ERROR };
    }

    try {
      if (!(await getActiveSession(taskId))) {
        return { type: "sandbox-list-files" as const, error: NO_SESSION_HINT };
      }

      const resolved = resolveWorkspacePath(directoryPath);
      if (!resolved.ok) {
        return { type: "sandbox-list-files" as const, error: resolved.error };
      }

      const result = await invoke(taskId, "listFiles", {
        directoryPath: resolved.path,
      });
      return {
        type: "sandbox-list-files" as const,
        output: result.text,
        isError: result.isError,
        directoryPath: resolved.path,
      };
    } catch (error) {
      return {
        type: "sandbox-list-files" as const,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  },
});

/** All sandbox tools, keyed by the tool name exposed to the model. */
export const sandboxTools = {
  createSandboxSession,
  stopSandboxSession,
  executeCode,
  executeCommand,
  writeFiles,
  readFiles,
  listFiles,
};
