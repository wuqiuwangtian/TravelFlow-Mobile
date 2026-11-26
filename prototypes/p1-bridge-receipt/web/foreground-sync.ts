export interface ForegroundSyncResult {
  state: "unpaired" | "idle" | "synced" | "blocked" | "retry";
  reason?: string;
  changed?: boolean;
}

// Each wake can start one pass. A pass re-reads the durable queue, so duplicate
// lifecycle events need no queue of their own. Polling also discovers desktop edits.
export function createForegroundSync(options: {
  available: () => boolean;
  exchange: () => Promise<ForegroundSyncResult>;
  present: (result: ForegroundSyncResult) => Promise<void>;
}) {
  const pollMs = 5000;
  let delay = pollMs;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running = false;
  let blocked = false;
  let pairingGeneration = 0;

  function cancelTimer() {
    clearTimeout(timer);
    timer = undefined;
  }

  async function wake() {
    cancelTimer();
    if (blocked || running || !options.available()) return;
    running = true;
    const generation = pairingGeneration;
    try {
      const result = await options.exchange();
      if (generation !== pairingGeneration) return;
      blocked = result.state === "blocked";
      delay = result.state === "retry" ? Math.min(delay * 2, 30000) : pollMs;
      await options.present(result);
    } catch {
      delay = Math.min(delay * 2, 30000);
    } finally {
      running = false;
      if (!blocked && options.available()) timer = setTimeout(wake, delay);
    }
  }

  return {
    wake,
    cancelTimer,
    paired() {
      pairingGeneration++;
      blocked = false;
      delay = pollMs;
      void wake();
    },
  };
}
