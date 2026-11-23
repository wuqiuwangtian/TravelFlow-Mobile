import { Capacitor, registerPlugin } from "./capacitor-core.js";
import { summarizeLedger } from "./ledger-core.js";
import {
  MAX_AMOUNT_CENTS,
  buildExpensePatchIntent,
  buildReceiptLookupIntent,
  canonicalizeControlDocument,
  canonicalizeQueryDocument,
  parseStrictAmountCents,
} from "./bridge-command.js";

type ScenarioName =
  | "before-commit"
  | "after-commit-drop-reply"
  | "lock-busy-commit"
  | "lock-busy-rollback"
  | "bound-int32-max"
  | "bound-int32-over"
  | "bound-max-cents";

type FaultMode = "none" | "before_commit" | "after_commit_drop_reply";

interface PendingRecord {
  operationId: string;
  intentJson: string;
  amountCents: number;
  expectedRevision: number;
}

interface PendingStateResult {
  pending: PendingRecord | null;
  confirmedOp: string | null;
  confirmedRev: number;
  confirmedIntentJson: string | null;
  confirmedAmountCents: number;
  confirmedExpectedRevision: number;
}

interface SubmitResult {
  status: "committed" | "replayed" | "intent_conflict" | "stale_head";
  operationId: string;
  revision: number;
}

interface LookupResult {
  status: "confirmed" | "no_receipt" | "pending_busy" | "intent_conflict";
  operationId: string;
  revision: number;
  plainReceipts: number;
  callerPid: number;
}

interface InspectStateResult {
  scenario: string;
  seeded: boolean;
  head: number;
  cents: number;
  historyCount: number;
  receiptCount: number;
  outboxCount: number;
  opReceiptCount: number;
  opOutboxCount: number;
  opHistoryCount: number;
  ticketExists: boolean;
  ticketIntact: boolean;
  ticketText: string | null;
  unmanagedIntact: boolean;
  journal: string;
  sqlite: string;
  callerPid: number;
  pending: PendingRecord | null;
  confirmedOp: string | null;
  confirmedRev: number;
  committedIntent: string | null;
}

interface P1BridgeReceiptPlugin {
  seedScenario(options: { scenario: ScenarioName }): Promise<InspectStateResult>;
  savePendingIntent(options: {
    scenario: ScenarioName;
    operationId: string;
    intentJson: string;
    amountCents: number;
    expectedRevision: number;
  }): Promise<PendingStateResult>;
  loadPendingIntent(options: { scenario: ScenarioName }): Promise<PendingStateResult>;
  confirmPendingIntent(options: {
    scenario: ScenarioName;
    operationId: string;
    revision: number;
  }): Promise<PendingStateResult>;
  submitExpensePatch(options: {
    scenario: ScenarioName;
    operationId: string;
    intentJson: string;
    amountCents: number;
    expectedRevision: number;
    faultMode: FaultMode;
  }): Promise<SubmitResult>;
  lookupReceipt(options: {
    scenario: ScenarioName;
    operationId: string;
    intentJson: string;
    queryJson: string;
  }): Promise<LookupResult>;
  inspectState(options: {
    scenario: ScenarioName;
    operationId?: string;
  }): Promise<InspectStateResult>;
  holdWriterLock(options: {
    scenario: ScenarioName;
    operationId: string;
    intentJson: string;
    amountCents: number;
    expectedRevision: number;
    commitOnRelease: boolean;
  }): Promise<{ writerPid: number; callerPid: number }>;
  releaseWriterLock(options: { scenario: ScenarioName }): Promise<{ writerPid: number; callerPid: number }>;
}

const bridge = registerPlugin<P1BridgeReceiptPlugin>("P1BridgeReceipt");

function byId<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Missing element #${id}`);
  return el as T;
}

const scenarioEl = byId<HTMLSelectElement>("scenario");
const faultModeEl = byId<HTMLSelectElement>("fault-mode");
const amountEl = byId<HTMLInputElement>("amount-cents");
const runtimeEl = byId<HTMLParagraphElement>("runtime");
const ledgerEl = byId<HTMLParagraphElement>("ledger");
const pendingEl = byId<HTMLParagraphElement>("pending-state");
const actionStatusEl = byId<HTMLParagraphElement>("action-status");
const errorEl = byId<HTMLParagraphElement>("error");
const snapshotEl = byId<HTMLPreElement>("snapshot-json");

const buttonIds = [
  "seed-scenario",
  "refresh-state",
  "prepare-pending",
  "submit-patch",
  "recover-pending",
  "replay-confirmed",
  "conflict-check",
] as const;

let lastOutcome: Record<string, unknown> | null = null;
let lastState: InspectStateResult | null = null;

function currentScenario(): ScenarioName {
  return scenarioEl.value as ScenarioName;
}

function currentFaultMode(): FaultMode {
  return faultModeEl.value as FaultMode;
}

function currentAmountCents(): number {
  return parseStrictAmountCents(amountEl.value);
}

function setControlsEnabled(enabled: boolean): void {
  scenarioEl.disabled = !enabled;
  faultModeEl.disabled = !enabled;
  amountEl.disabled = !enabled;
  for (const id of buttonIds) {
    byId<HTMLButtonElement>(id).disabled = !enabled;
  }
}

function renderState(state: InspectStateResult): void {
  lastState = state;
  if (!state.seeded) {
    ledgerEl.textContent = `场景 ${state.scenario} 尚未初始化`;
    pendingEl.textContent = "待核实操作：无";
    snapshotEl.textContent = JSON.stringify(state, null, 2);
    return;
  }
  const summary = summarizeLedger({
    expenses: [{ id: "fixture-expense-1", amount_cents: state.cents }],
    adjustments: [],
  });
  if (summary.paid_cents !== state.cents) {
    throw new Error("Native/TS ledger projection mismatch");
  }
  ledgerEl.textContent =
    `场景 ${state.scenario} · 修订 ${state.head} · 金额 ¥${(summary.paid_cents / 100).toFixed(2)} (${state.cents}分)` +
    ` · 历史 ${state.historyCount} · 回执 ${state.receiptCount} · 待发送 ${state.outboxCount}` +
    ` · 历史票据 ${state.ticketIntact ? "可读" : "缺失"}`;
  if (state.pending) {
    pendingEl.textContent =
      `发现待核实操作：${state.pending.operationId}（预期修订 ${state.pending.expectedRevision} -> ${state.pending.amountCents}分）`;
  } else if (state.confirmedOp) {
    pendingEl.textContent = `已确认操作：${state.confirmedOp}（修订 ${state.confirmedRev}）`;
  } else {
    pendingEl.textContent = "待核实操作：无";
  }
  snapshotEl.textContent = JSON.stringify(state, null, 2);
}

async function refreshState(operationId?: string): Promise<InspectStateResult> {
  const state = await bridge.inspectState({
    scenario: currentScenario(),
    ...(operationId ? { operationId } : {}),
  });
  renderState(state);
  return state;
}

async function persistNewPendingIntent(): Promise<PendingRecord> {
  const scenario = currentScenario();
  const amountCents = currentAmountCents();
  const expectedRevision = 2;
  const operationId = crypto.randomUUID();
  const intent = buildExpensePatchIntent({
    operationId,
    expectedRevision,
    amountCents,
    notes: `p1-bridge-correction:${scenario}:${amountCents}`,
  });
  const intentJson = canonicalizeControlDocument(intent);
  const saved = await bridge.savePendingIntent({
    scenario,
    operationId,
    intentJson,
    amountCents,
    expectedRevision,
  });
  if (!saved.pending || saved.pending.operationId !== operationId || saved.pending.intentJson !== intentJson) {
    throw new Error("Caller pending intent was not durably persisted");
  }
  return saved.pending;
}

async function runAction(label: string, work: () => Promise<Record<string, unknown>>): Promise<void> {
  setControlsEnabled(false);
  errorEl.textContent = "";
  actionStatusEl.textContent = `正在执行：${label}`;
  try {
    const outcome = await work();
    lastOutcome = outcome;
    actionStatusEl.textContent = `${label}完成：${String(outcome.status ?? "ok")}`;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    lastOutcome = { status: "error", error: message };
    errorEl.textContent = message;
    actionStatusEl.textContent = `${label}失败`;
  } finally {
    setControlsEnabled(true);
  }
}

byId<HTMLButtonElement>("seed-scenario").onclick = () =>
  void runAction("初始化隔离场景", async () => {
    const state = await bridge.seedScenario({ scenario: currentScenario() });
    renderState(state);
    return { status: "seeded", state };
  });

byId<HTMLButtonElement>("refresh-state").onclick = () =>
  void runAction("刷新状态", async () => {
    const state = await refreshState();
    return { status: "refreshed", state };
  });

byId<HTMLButtonElement>("prepare-pending").onclick = () =>
  void runAction("保存待核实意图", async () => {
    const pending = await persistNewPendingIntent();
    const state = await refreshState(pending.operationId);
    return { status: "prepared", pending, state };
  });

byId<HTMLButtonElement>("submit-patch").onclick = () =>
  void runAction("提交虚构消费更正", async () => {
    const scenario = currentScenario();
    const faultMode = currentFaultMode();
    const pending = await persistNewPendingIntent();
    // 持久保存原操作 ID 与意图后再经 Capacitor 桥派发原生写入。
    const result = await bridge.submitExpensePatch({
      scenario,
      operationId: pending.operationId,
      intentJson: pending.intentJson,
      amountCents: pending.amountCents,
      expectedRevision: pending.expectedRevision,
      faultMode,
    });
    if (result.status === "committed" || result.status === "replayed") {
      await bridge.confirmPendingIntent({
        scenario,
        operationId: pending.operationId,
        revision: result.revision,
      });
    }
    const state = await refreshState(pending.operationId);
    return { status: result.status, result, pending, state };
  });

byId<HTMLButtonElement>("recover-pending").onclick = () =>
  void runAction("核实并恢复原操作", async () => {
    const scenario = currentScenario();
    const callerState = await bridge.loadPendingIntent({ scenario });
    if (!callerState.pending) {
      const state = await refreshState(callerState.confirmedOp ?? undefined);
      return {
        status: callerState.confirmedOp ? "already_confirmed" : "idle",
        confirmedOp: callerState.confirmedOp,
        confirmedRev: callerState.confirmedRev,
        state,
      };
    }
    const pending = callerState.pending;
    const queryJson = canonicalizeQueryDocument(buildReceiptLookupIntent(pending.operationId));
    const lookup = await bridge.lookupReceipt({
      scenario,
      operationId: pending.operationId,
      intentJson: pending.intentJson,
      queryJson,
    });
    if (lookup.status === "pending_busy") {
      // 写锁忙时保留原操作 ID 和意图，不重试也不清除。
      const state = await refreshState(pending.operationId);
      return { status: "pending_busy", lookup, pending, state };
    }
    if (lookup.status === "confirmed") {
      await bridge.confirmPendingIntent({
        scenario,
        operationId: pending.operationId,
        revision: lookup.revision,
      });
      const state = await refreshState(pending.operationId);
      return { status: "confirmed_existing", lookup, pending, state };
    }
    if (lookup.status === "no_receipt") {
      const retry = await bridge.submitExpensePatch({
        scenario,
        operationId: pending.operationId,
        intentJson: pending.intentJson,
        amountCents: pending.amountCents,
        expectedRevision: pending.expectedRevision,
        faultMode: "none",
      });
      if (retry.status === "committed" || retry.status === "replayed") {
        await bridge.confirmPendingIntent({
          scenario,
          operationId: pending.operationId,
          revision: retry.revision,
        });
      }
      const state = await refreshState(pending.operationId);
      return { status: `recovered_${retry.status}`, lookup, retry, pending, state };
    }
    const state = await refreshState(pending.operationId);
    return { status: lookup.status, lookup, pending, state };
  });

byId<HTMLButtonElement>("replay-confirmed").onclick = () =>
  void runAction("重放已确认操作", async () => {
    const scenario = currentScenario();
    const callerState = await bridge.loadPendingIntent({ scenario });
    if (!callerState.confirmedOp || !callerState.confirmedIntentJson) {
      throw new Error("No confirmed operation to replay");
    }
    const replay = await bridge.submitExpensePatch({
      scenario,
      operationId: callerState.confirmedOp,
      intentJson: callerState.confirmedIntentJson,
      amountCents: callerState.confirmedAmountCents,
      expectedRevision: callerState.confirmedExpectedRevision,
      faultMode: "none",
    });
    const state = await refreshState(callerState.confirmedOp);
    return { status: replay.status, replay, state };
  });

byId<HTMLButtonElement>("conflict-check").onclick = () =>
  void runAction("验证同ID异意图拒绝", async () => {
    const scenario = currentScenario();
    const callerState = await bridge.loadPendingIntent({ scenario });
    if (!callerState.confirmedOp) {
      throw new Error("No confirmed operation for conflict check");
    }
    const conflictingAmountCents =
      callerState.confirmedAmountCents >= MAX_AMOUNT_CENTS
        ? callerState.confirmedAmountCents - 1
        : callerState.confirmedAmountCents + 55;
    const conflictingIntent = buildExpensePatchIntent({
      operationId: callerState.confirmedOp,
      expectedRevision: callerState.confirmedExpectedRevision,
      amountCents: conflictingAmountCents,
      notes: `conflicting-intent:${scenario}`,
    });
    const conflict = await bridge.submitExpensePatch({
      scenario,
      operationId: callerState.confirmedOp,
      intentJson: canonicalizeControlDocument(conflictingIntent),
      amountCents: conflictingAmountCents,
      expectedRevision: callerState.confirmedExpectedRevision,
      faultMode: "none",
    });
    const state = await refreshState(callerState.confirmedOp);
    return { status: conflict.status, conflict, state };
  });

scenarioEl.onchange = () => {
  void runAction("切换场景", async () => {
    const state = await refreshState();
    return { status: "switched", state };
  });
};

// 只读调试接口与受控测试辅助：供 CDP 验证脚本查询最新状态及协调独立写进程锁。
(window as unknown as Record<string, unknown>).__tfP1Bridge = {
  getLastOutcome: () => lastOutcome,
  getLastState: () => lastState,
  inspectState: (scenario: ScenarioName, operationId?: string) =>
    bridge.inspectState({ scenario, ...(operationId ? { operationId } : {}) }),
  holdWriterLock: (options: {
    scenario: ScenarioName;
    operationId: string;
    intentJson: string;
    amountCents: number;
    expectedRevision: number;
    commitOnRelease: boolean;
  }) => bridge.holdWriterLock(options),
  releaseWriterLock: (scenario: ScenarioName) => bridge.releaseWriterLock({ scenario }),
};

async function init(): Promise<void> {
  try {
    if (!Capacitor.isNativePlatform()) {
      throw new Error("P1 bridge receipt prototype requires Android native runtime");
    }
    const state = await refreshState();
    runtimeEl.textContent = `Android原生桥已就绪（PID ${state.callerPid}）`;
    setControlsEnabled(true);
  } catch (error) {
    runtimeEl.textContent = "原生桥初始化失败";
    errorEl.textContent = error instanceof Error ? error.message : String(error);
  }
}

void init();
