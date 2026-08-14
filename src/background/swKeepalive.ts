// =============================================================================
// MV3 service-worker keepalive for long-running one-off message handlers.
//
// Chrome's service worker has a ~30s idle timer. A pending chrome.runtime
// sendResponse callback does not, by itself, reliably reset that timer once
// the worker has gone a while without touching an extension API — so a
// handler whose work (LLM-driven multi-step graph builds, SharePoint/mailbox
// indexing) can run well past 30s gets its response silently dropped when the
// worker is evicted mid-flight: "A listener indicated an asynchronous
// response by returning true, but the message channel closed before a
// response was received."
//
// This used to be masked by an accident of history: the sidebar sent a
// keepalive port ping every 20s for the entire time the panel was open,
// which — as a side effect, not by design — also kept the SW's global idle
// timer from firing during any of these unrelated one-off operations. Once
// that ping was correctly gated to only run during an active agent task
// (see Sidebar.tsx), operations like a knowledge-graph rebuild lost that
// accidental protection and started hitting the eviction-mid-flight error.
//
// Wrap any handler whose work can plausibly run longer than ~30s in
// withSwKeepalive so a trivial extension-API call periodically resets the
// idle timer for the duration of the work, instead of relying on an
// unrelated caller to keep pinging on its behalf.
// =============================================================================

const KEEPALIVE_INTERVAL_MS = 15_000;

export async function withSwKeepalive<T>(work: () => Promise<T>): Promise<T> {
  const timer = setInterval(() => {
    void chrome.storage.session.get('__sw_keepalive__').catch(() => {});
  }, KEEPALIVE_INTERVAL_MS);
  try {
    return await work();
  } finally {
    clearInterval(timer);
  }
}
