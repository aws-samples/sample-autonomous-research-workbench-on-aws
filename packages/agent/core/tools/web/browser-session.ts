import type { PlaywrightBrowser } from "bedrock-agentcore/browser/playwright";

/**
 * Process-wide AgentCore Browser session used by the web-search tool.
 *
 * AgentCore Browser is billed per second for the whole session lifetime —
 * including idle time — so a leaked session keeps costing money until its
 * server-side timeout fires. Two independent guards bound that exposure:
 *
 * - `IDLE_STOP_MS`: an idle timer stops the session shortly after the last
 *   search, so a run that searches once doesn't hold a browser for minutes.
 * - `SESSION_TIMEOUT_SECONDS`: the server-side timeout, which is the real
 *   backstop. The worker container can be frozen or killed between AgentCore
 *   invocations, in which case no local `finally` ever runs; this cap is what
 *   guarantees the session is eventually reclaimed.
 *
 * The session is a module singleton rather than per-task: cold start costs
 * ~7s (StartBrowserSession + CDP connect) versus ~1s on a warm session, and
 * successive searches within one run are the common case.
 *
 * Access is serialized by {@link withBrowser}. The session is a single remote
 * browser with a single tab, and it rejects concurrent use on two levels: the
 * service refuses a second CDP connection to the same session ("Too many
 * connections"), and two overlapping navigations on one tab abort each other
 * (`net::ERR_ABORTED`). Models routinely emit parallel tool calls, so the
 * queue is what makes that safe.
 */

/**
 * Server-side session lifetime. Deliberately short: it is the only guard that
 * survives the container dying mid-run, so it caps the cost of an orphaned
 * session. The idle timer normally stops sessions long before this.
 */
const SESSION_TIMEOUT_SECONDS = 300;

/** Stop an idle session after this long with no searches. */
const IDLE_STOP_MS = 60_000;

type State = {
  browser: PlaywrightBrowser;
  idleTimer: NodeJS.Timeout | null;
};

let state: State | null = null;
/** In-flight startup, so concurrent searches share one session. */
let starting: Promise<PlaywrightBrowser> | null = null;

function clearIdleTimer(current: State): void {
  if (current.idleTimer) {
    clearTimeout(current.idleTimer);
    current.idleTimer = null;
  }
}

function armIdleTimer(current: State): void {
  clearIdleTimer(current);
  current.idleTimer = setTimeout(() => {
    void stopBrowserSession();
  }, IDLE_STOP_MS);
  // Don't hold the event loop open just to stop a browser session; the
  // server-side timeout covers a process that exits first.
  current.idleTimer.unref?.();
}

/**
 * Get the shared browser session, starting one if needed. Callers must go
 * through {@link withBrowser}, which serializes access.
 */
async function acquireBrowser(): Promise<PlaywrightBrowser> {
  if (state) {
    clearIdleTimer(state);
    return state.browser;
  }

  // Concurrent tool calls must not each start a session (each one bills).
  starting ??= (async () => {
    const { PlaywrightBrowser: Client } = await import(
      "bedrock-agentcore/browser/playwright"
    );
    const browser = new Client({
      region: process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION,
    });
    await browser.startSession({
      sessionName: "web-search",
      timeout: SESSION_TIMEOUT_SECONDS,
    });
    state = { browser, idleTimer: null };
    return browser;
  })();

  try {
    return await starting;
  } catch (error) {
    // Leave no half-started state behind: the next call should retry cleanly.
    state = null;
    throw error;
  } finally {
    starting = null;
  }
}

/** Mark the session idle, arming the stop timer. */
function releaseBrowser(): void {
  if (state) {
    armIdleTimer(state);
  }
}

/** Tail of the serialized access queue. */
let queue: Promise<unknown> = Promise.resolve();

/**
 * Run `fn` with exclusive use of the shared browser session, queued behind any
 * other in-flight caller. Serialization is required, not just defensive: the
 * session permits only one CDP connection and one navigation at a time (see
 * the module docs).
 *
 * The queue is never broken by a rejecting `fn` — the chain continues from a
 * settled promise, so one failed search doesn't deadlock later ones.
 */
export function withBrowser<T>(
  fn: (browser: PlaywrightBrowser) => Promise<T>
): Promise<T> {
  const result = queue.then(async () => {
    const browser = await acquireBrowser();
    try {
      return await fn(browser);
    } finally {
      // Hand the session back so its idle timer can stop it.
      releaseBrowser();
    }
  });
  queue = result.catch(() => {});
  return result;
}

/**
 * Stop the shared session and release its resources. Safe to call when no
 * session is active. Never throws — a failed stop still drops the local
 * handle, and the server-side timeout reclaims the session.
 */
export async function stopBrowserSession(): Promise<boolean> {
  const current = state;
  if (!current) {
    return false;
  }
  clearIdleTimer(current);
  state = null;

  try {
    await current.browser.stopSession();
    return true;
  } catch {
    return false;
  }
}
