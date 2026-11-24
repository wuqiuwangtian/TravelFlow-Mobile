import { Capacitor, registerPlugin } from "./capacitor-core.js";
import { summarizeLedger } from "./ledger-core.js";
import {
  MAX_AMOUNT_CENTS,
  type ExpenseCreateIntent,
  type ExpensePatchIntent,
  type ReceiptLookupIntent,
  buildExpensePatchIntent,
  buildReceiptLookupIntent,
  canonicalizeControlDocument,
  canonicalizeQueryDocument,
  parseStrictAmountCents,
  validateExpenseCreateAmount,
} from "./bridge-command.js";

type ScenarioName =
  | "before-commit"
  | "after-commit-drop-reply"
  | "lock-busy-commit"
  | "lock-busy-rollback"
  | "bound-int32-max"
  | "bound-int32-over"
  | "bound-max-cents";

type CreateScenarioName =
  | "create-before-commit"
  | "create-after-commit"
  | "create-conflict-amount"
  | "create-conflict-share";

type FaultMode = "none" | "before_commit" | "after_commit_drop_reply";

interface DesktopCreateFixture {
  command: ExpenseCreateIntent;
  receipt_query: ReceiptLookupIntent;
}

interface SyntheticPrincipal {
  authenticated: boolean;
  can_query: boolean;
  can_write: boolean;
  dataset_id: string;
  source_device_id: string;
}

interface CreatePendingRecord {
  operationId: string;
  rawCommandJson: string;
  canonicalIntentJson: string;
}

interface CreatePendingStateResult {
  pending: CreatePendingRecord | null;
  confirmedOp: string | null;
  confirmedRevisionId: string | null;
}

interface CreateExecuteResult {
  accepted: boolean;
  kind?: "committed";
  replayed?: boolean;
  effect?: "changed";
  result_revision_id?: string;
  error?: string;
}

interface CreateLookupResult {
  accepted: boolean;
  state?: "committed" | "not_found_at_settled_read" | "pending_busy";
  receipt?: {
    effect: string;
    result_revision_id: string;
  };
  error?: string;
}

interface CreateExpenseRow {
  id: string;
  title: string;
  amount_cents: number;
  currency: string;
  paid_on: string | null;
  category: string;
  day: number | null;
  activity_id: string | null;
  notes: string;
  receipt_ids: string[];
  allow_shared_receipts: boolean;
  budget_item_id: string | null;
  settles_budget: boolean;
}

interface CreateInspectStateResult {
  seeded: boolean;
  headRevisionId: string | null;
  expenses: CreateExpenseRow[];
  revisions: Array<{
    revision_id: string;
    parent_revision_id: string | null;
    snapshot: { expenses: CreateExpenseRow[] };
  }>;
  revisionCount: number;
  receiptCount: number;
  outboxCount: number;
  receipts: Array<{
    dataset_id: string;
    source_device_id: string;
    operation_id: string;
    intent_json: string;
    effect: string;
    result_revision_id: string;
  }>;
  outbox: Array<{
    dataset_id: string;
    source_device_id: string;
    operation_id: string;
    result_revision_id: string;
  }>;
  journal: string;
  sqlite: string;
  callerPid: number;
  receiptReadCount: number;
  pending: CreatePendingRecord | null;
  confirmedOp: string | null;
  confirmedRevisionId: string | null;
}

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
  seedCreateScenario(options: {
    scenario: CreateScenarioName;
    datasetId: string;
    travelId: string;
    branchId: string;
    initialRevisionId: string;
  }): Promise<CreateInspectStateResult>;
  saveCreatePendingIntent(options: {
    scenario: CreateScenarioName;
    operationId: string;
    rawCommandJson: string;
    canonicalIntentJson: string;
  }): Promise<CreatePendingStateResult>;
  loadCreatePendingIntent(options: { scenario: CreateScenarioName }): Promise<CreatePendingStateResult>;
  confirmCreatePendingIntent(options: {
    scenario: CreateScenarioName;
    operationId: string;
    revisionId: string;
  }): Promise<CreatePendingStateResult>;
  submitExpenseCreate(options: {
    scenario: CreateScenarioName;
    rawCommandJson: string;
    canonicalIntentJson: string;
    faultMode: FaultMode;
  }): Promise<CreateExecuteResult>;
  submitCreateNotesPatch(options: {
    scenario: CreateScenarioName;
    rawCommandJson: string;
    canonicalIntentJson: string;
  }): Promise<CreateExecuteResult>;
  lookupCreateReceipt(options: {
    scenario: CreateScenarioName;
    datasetId: string;
    sourceDeviceId: string;
    operationId: string;
    canonicalIntentJson?: string;
    principal: SyntheticPrincipal;
  }): Promise<CreateLookupResult>;
  inspectCreateState(options: { scenario: CreateScenarioName }): Promise<CreateInspectStateResult>;
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
const createScenarioEl = byId<HTMLSelectElement>("create-scenario");
const createFaultModeEl = byId<HTMLSelectElement>("create-fault-mode");
const createLedgerEl = byId<HTMLParagraphElement>("create-ledger");
const createStatusEl = byId<HTMLParagraphElement>("create-status");

const buttonIds = [
  "seed-scenario",
  "refresh-state",
  "prepare-pending",
  "submit-patch",
  "recover-pending",
  "replay-confirmed",
  "conflict-check",
] as const;

const createButtonIds = [
  "create-seed",
  "create-submit",
  "create-recover",
  "create-advance-head",
  "create-replay",
  "create-check-rejections",
  "create-check-auth",
] as const;

let lastOutcome: Record<string, unknown> | null = null;
let lastState: InspectStateResult | null = null;
let lastCreateOutcome: Record<string, unknown> | null = null;
let desktopCreateFixture: DesktopCreateFixture | null = null;

const SYNTHETIC_PRINCIPAL: SyntheticPrincipal = {
  authenticated: true,
  can_query: true,
  can_write: true,
  dataset_id: "fixture-dataset",
  source_device_id: "fixture-device",
};

function currentCreateScenario(): CreateScenarioName {
  return createScenarioEl.value as CreateScenarioName;
}

function currentCreateFaultMode(): FaultMode {
  return createFaultModeEl.value as FaultMode;
}

function requireCreateFixture(): DesktopCreateFixture {
  if (!desktopCreateFixture) {
    throw new Error("Desktop create fixture not loaded");
  }
  return desktopCreateFixture;
}

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
  createScenarioEl.disabled = !enabled;
  createFaultModeEl.disabled = !enabled;
  for (const id of buttonIds) {
    byId<HTMLButtonElement>(id).disabled = !enabled;
  }
  for (const id of createButtonIds) {
    byId<HTMLButtonElement>(id).disabled = !enabled;
  }
}

function renderCreateState(state: CreateInspectStateResult): void {
  if (!state.seeded) {
    createLedgerEl.textContent = `新增场景 ${currentCreateScenario()} 尚未初始化`;
    return;
  }
  const summary = summarizeLedger({
    expenses: state.expenses.map((item) => ({ id: item.id, amount_cents: item.amount_cents })),
    adjustments: [],
  });
  createLedgerEl.textContent =
    `空账本场景 ${currentCreateScenario()} · 头版本 ${state.headRevisionId} · 消费 ${state.expenses.length} 笔` +
    `（合计 ¥${(summary.paid_cents / 100).toFixed(2)}）· 修订 ${state.revisionCount} · 回执 ${state.receiptCount} · 待发送 ${state.outboxCount}`;
}

async function runCreateAction(label: string, work: () => Promise<Record<string, unknown>>): Promise<void> {
  setControlsEnabled(false);
  errorEl.textContent = "";
  createStatusEl.textContent = `正在执行：${label}`;
  try {
    const outcome = await work();
    lastCreateOutcome = outcome;
    createStatusEl.textContent = `${label}完成：${String(outcome.status ?? "ok")}`;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    lastCreateOutcome = { status: "error", error: message };
    errorEl.textContent = message;
    createStatusEl.textContent = `${label}失败`;
  } finally {
    setControlsEnabled(true);
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
        : callerState.confirmedAmountCents + 1;
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

createScenarioEl.onchange = () => {
  void runCreateAction("切换新增场景", async () => {
    const state = await bridge.inspectCreateState({ scenario: currentCreateScenario() });
    renderCreateState(state);
    return { status: "switched", state };
  });
};

byId<HTMLButtonElement>("create-seed").onclick = () =>
  void runCreateAction("初始化空账本", async () => {
    const fixture = requireCreateFixture();
    const state = await bridge.seedCreateScenario({
      scenario: currentCreateScenario(),
      datasetId: fixture.command.operation.dataset_id,
      travelId: fixture.command.target.travel_id,
      branchId: fixture.command.target.branch_id,
      initialRevisionId: fixture.command.expected_revision_id,
    });
    renderCreateState(state);
    return { status: "seeded", state };
  });

byId<HTMLButtonElement>("create-submit").onclick = () =>
  void runCreateAction("提交固定新增午餐", async () => {
    const scenario = currentCreateScenario();
    const faultMode = currentCreateFaultMode();
    const fixture = requireCreateFixture();
    const rawCommandJson = JSON.stringify(fixture.command);
    const canonicalIntentJson = canonicalizeControlDocument(fixture.command);
    await bridge.saveCreatePendingIntent({
      scenario,
      operationId: fixture.command.operation.operation_id,
      rawCommandJson,
      canonicalIntentJson,
    });
    const result = await bridge.submitExpenseCreate({
      scenario,
      rawCommandJson,
      canonicalIntentJson,
      faultMode,
    });
    if (result.accepted && result.result_revision_id) {
      await bridge.confirmCreatePendingIntent({
        scenario,
        operationId: fixture.command.operation.operation_id,
        revisionId: result.result_revision_id,
      });
    }
    const state = await bridge.inspectCreateState({ scenario });
    renderCreateState(state);
    return { status: result.accepted ? "committed" : (result.error ?? "rejected"), result, state };
  });

byId<HTMLButtonElement>("create-recover").onclick = () =>
  void runCreateAction("查询并恢复新增消费", async () => {
    const scenario = currentCreateScenario();
    const fixture = requireCreateFixture();
    const callerState = await bridge.loadCreatePendingIntent({ scenario });
    const pending = callerState.pending;
    if (!pending) {
      const state = await bridge.inspectCreateState({ scenario });
      renderCreateState(state);
      return { status: callerState.confirmedOp ? "already_confirmed" : "idle", state };
    }
    const lookup = await bridge.lookupCreateReceipt({
      scenario,
      datasetId: fixture.receipt_query.operation.dataset_id,
      sourceDeviceId: fixture.receipt_query.operation.source_device_id,
      operationId: pending.operationId,
      canonicalIntentJson: pending.canonicalIntentJson,
      principal: SYNTHETIC_PRINCIPAL,
    });
    if (!lookup.accepted) {
      if (lookup.error === "intent_conflict") {
        // 冲突时保留待核实记录，不确认也不清除。
        const state = await bridge.inspectCreateState({ scenario });
        renderCreateState(state);
        return { status: "intent_conflict", lookup, state };
      }
      throw new Error(`Receipt lookup rejected: ${lookup.error}`);
    }
    if (lookup.state === "committed" && lookup.receipt?.result_revision_id) {
      await bridge.confirmCreatePendingIntent({
        scenario,
        operationId: pending.operationId,
        revisionId: lookup.receipt.result_revision_id,
      });
      const state = await bridge.inspectCreateState({ scenario });
      renderCreateState(state);
      return { status: "confirmed_existing", lookup, state };
    }
    if (lookup.state === "not_found_at_settled_read") {
      const retry = await bridge.submitExpenseCreate({
        scenario,
        rawCommandJson: pending.rawCommandJson,
        canonicalIntentJson: pending.canonicalIntentJson,
        faultMode: "none",
      });
      if (!retry.accepted || !retry.result_revision_id) {
        throw new Error(`Retry create failed: ${JSON.stringify(retry)}`);
      }
      await bridge.confirmCreatePendingIntent({
        scenario,
        operationId: pending.operationId,
        revisionId: retry.result_revision_id,
      });
      const verifiedLookup = await bridge.lookupCreateReceipt({
        scenario,
        datasetId: fixture.receipt_query.operation.dataset_id,
        sourceDeviceId: fixture.receipt_query.operation.source_device_id,
        operationId: pending.operationId,
        canonicalIntentJson: pending.canonicalIntentJson,
        principal: SYNTHETIC_PRINCIPAL,
      });
      const state = await bridge.inspectCreateState({ scenario });
      renderCreateState(state);
      return { status: "recovered_by_retry", lookup, retry, verifiedLookup, state };
    }
    const state = await bridge.inspectCreateState({ scenario });
    renderCreateState(state);
    return { status: lookup.state ?? "unknown", lookup, state };
  });

byId<HTMLButtonElement>("create-advance-head").onclick = () =>
  void runCreateAction("推进分支头备注更正", async () => {
    const scenario = currentCreateScenario();
    const fixture = requireCreateFixture();
    const before = await bridge.inspectCreateState({ scenario });
    if (!before.headRevisionId) {
      throw new Error("Missing current headRevisionId");
    }
    const notesPatch: ExpensePatchIntent = {
      profile: fixture.command.profile,
      kind: "expense.patch",
      operation: {
        ...fixture.command.operation,
        operation_id: "fixture-op-notes",
      },
      target: { ...fixture.command.target },
      expected_revision_id: before.headRevisionId,
      payload: { notes: "虚构更正" },
    };
    const result = await bridge.submitCreateNotesPatch({
      scenario,
      rawCommandJson: JSON.stringify(notesPatch),
      canonicalIntentJson: canonicalizeControlDocument(notesPatch),
    });
    const state = await bridge.inspectCreateState({ scenario });
    renderCreateState(state);
    return { status: result.accepted ? "advanced" : (result.error ?? "rejected"), result, state };
  });

byId<HTMLButtonElement>("create-replay").onclick = () =>
  void runCreateAction("重放原请求与键重排请求", async () => {
    const scenario = currentCreateScenario();
    const fixture = requireCreateFixture();
    const originalCanon = canonicalizeControlDocument(fixture.command);
    const reorderedCommand = {
      ...Object.fromEntries(Object.entries(fixture.command).reverse()),
      payload: Object.fromEntries(Object.entries(fixture.command.payload).reverse()),
    } as ExpenseCreateIntent;
    const reorderedCanon = canonicalizeControlDocument(reorderedCommand);
    if (reorderedCanon !== originalCanon) {
      throw new Error("Reordered command canonical JSON mismatch");
    }
    const replayOriginal = await bridge.submitExpenseCreate({
      scenario,
      rawCommandJson: JSON.stringify(fixture.command),
      canonicalIntentJson: originalCanon,
      faultMode: "none",
    });
    const replayReordered = await bridge.submitExpenseCreate({
      scenario,
      rawCommandJson: JSON.stringify(reorderedCommand),
      canonicalIntentJson: reorderedCanon,
      faultMode: "none",
    });
    const state = await bridge.inspectCreateState({ scenario });
    renderCreateState(state);
    return { status: "replayed", replayOriginal, replayReordered, state };
  });

byId<HTMLButtonElement>("create-check-rejections").onclick = () =>
  void runCreateAction("验证冲突与非法金额拒绝", async () => {
    const scenario = currentCreateScenario();
    const fixture = requireCreateFixture();
    const current = await bridge.inspectCreateState({ scenario });
    if (!current.headRevisionId) {
      throw new Error("Missing current headRevisionId");
    }

    const diffAmountCmd: ExpenseCreateIntent = {
      ...fixture.command,
      payload: { ...fixture.command.payload, amount_cents: 8636 },
    };
    const diffAmount = await bridge.submitExpenseCreate({
      scenario,
      rawCommandJson: JSON.stringify(diffAmountCmd),
      canonicalIntentJson: canonicalizeControlDocument(diffAmountCmd),
      faultMode: "none",
    });

    const diffShareCmd: ExpenseCreateIntent = {
      ...fixture.command,
      payload: { ...fixture.command.payload, allow_shared_receipts: true },
    };
    const diffShare = await bridge.submitExpenseCreate({
      scenario,
      rawCommandJson: JSON.stringify(diffShareCmd),
      canonicalIntentJson: canonicalizeControlDocument(diffShareCmd),
      faultMode: "none",
    });

    const staleBaselineCmd: ExpenseCreateIntent = {
      ...fixture.command,
      operation: { ...fixture.command.operation, operation_id: "fixture-op-second" },
      target: { ...fixture.command.target, entity_id: "fixture-second" },
    };
    const staleBaseline = await bridge.submitExpenseCreate({
      scenario,
      rawCommandJson: JSON.stringify(staleBaselineCmd),
      canonicalIntentJson: canonicalizeControlDocument(staleBaselineCmd),
      faultMode: "none",
    });

    const duplicateEntityCmd: ExpenseCreateIntent = {
      ...fixture.command,
      operation: { ...fixture.command.operation, operation_id: "fixture-op-second" },
      expected_revision_id: current.headRevisionId,
    };
    const duplicateEntity = await bridge.submitExpenseCreate({
      scenario,
      rawCommandJson: JSON.stringify(duplicateEntityCmd),
      canonicalIntentJson: canonicalizeControlDocument(duplicateEntityCmd),
      faultMode: "none",
    });

    const invalidAmounts: Array<{ amount: unknown; tsError: string; nativeResult: CreateExecuteResult }> = [];
    for (const badAmount of [0, true, 1.25, 10000000000] as unknown[]) {
      const tsCheck = validateExpenseCreateAmount(badAmount);
      if (!("error" in tsCheck)) {
        throw new Error(`Expected TS rejection for ${String(badAmount)}`);
      }
      const badCommand = {
        ...fixture.command,
        operation: { ...fixture.command.operation, operation_id: "fixture-op-second" },
        target: { ...fixture.command.target, entity_id: "fixture-second" },
        expected_revision_id: current.headRevisionId,
        payload: { ...fixture.command.payload, amount_cents: badAmount },
      };
      const nativeResult = await bridge.submitExpenseCreate({
        scenario,
        rawCommandJson: JSON.stringify(badCommand),
        canonicalIntentJson: JSON.stringify(badCommand),
        faultMode: "none",
      });
      invalidAmounts.push({ amount: badAmount, tsError: tsCheck.error, nativeResult });
    }

    const state = await bridge.inspectCreateState({ scenario });
    renderCreateState(state);
    return {
      status: "rejections_checked",
      diffAmount,
      diffShare,
      staleBaseline,
      duplicateEntity,
      invalidAmounts,
      state,
    };
  });

byId<HTMLButtonElement>("create-check-auth").onclick = () =>
  void runCreateAction("验证身份与权限拒绝查询", async () => {
    const scenario = currentCreateScenario();
    const fixture = requireCreateFixture();
    const results: Array<{ mismatch: Record<string, unknown>; readsBefore: number; readsAfter: number; response: CreateLookupResult }> = [];
    for (const mismatch of [
      { can_query: false },
      { source_device_id: "fixture-other" },
      { authenticated: false },
    ]) {
      const before = await bridge.inspectCreateState({ scenario });
      const response = await bridge.lookupCreateReceipt({
        scenario,
        datasetId: fixture.receipt_query.operation.dataset_id,
        sourceDeviceId: fixture.receipt_query.operation.source_device_id,
        operationId: fixture.receipt_query.operation.operation_id,
        principal: { ...SYNTHETIC_PRINCIPAL, ...mismatch },
      });
      const after = await bridge.inspectCreateState({ scenario });
      results.push({
        mismatch,
        readsBefore: before.receiptReadCount,
        readsAfter: after.receiptReadCount,
        response,
      });
    }
    const state = await bridge.inspectCreateState({ scenario });
    renderCreateState(state);
    return { status: "auth_checked", results, state };
  });

// 只读调试接口与受控测试辅助：供 CDP 验证脚本查询最新状态及协调独立写进程锁。
(window as unknown as Record<string, unknown>).__tfP1Bridge = {
  getLastOutcome: () => lastOutcome,
  getLastState: () => lastState,
  getLastCreateOutcome: () => lastCreateOutcome,
  inspectState: (scenario: ScenarioName, operationId?: string) =>
    bridge.inspectState({ scenario, ...(operationId ? { operationId } : {}) }),
  inspectCreateState: (scenario: CreateScenarioName) =>
    bridge.inspectCreateState({ scenario }),
  stageCreateRecoveryConflict: async (scenario: CreateScenarioName, diff: { amount_cents?: number; allow_shared_receipts?: boolean }) => {
    const fixture = requireCreateFixture();
    await bridge.seedCreateScenario({
      scenario,
      datasetId: fixture.command.operation.dataset_id,
      travelId: fixture.command.target.travel_id,
      branchId: fixture.command.target.branch_id,
      initialRevisionId: fixture.command.expected_revision_id,
    });
    const originalCanon = canonicalizeControlDocument(fixture.command);
    const committed = await bridge.submitExpenseCreate({
      scenario,
      rawCommandJson: JSON.stringify(fixture.command),
      canonicalIntentJson: originalCanon,
      faultMode: "none",
    });
    const conflictingCommand: ExpenseCreateIntent = {
      ...fixture.command,
      payload: { ...fixture.command.payload, ...diff },
    };
    const conflictingCanon = canonicalizeControlDocument(conflictingCommand);
    const saved = await bridge.saveCreatePendingIntent({
      scenario,
      operationId: fixture.command.operation.operation_id,
      rawCommandJson: JSON.stringify(conflictingCommand),
      canonicalIntentJson: conflictingCanon,
    });
    const state = await bridge.inspectCreateState({ scenario });
    renderCreateState(state);
    return { committed, saved, conflictingCanon, state };
  },
  submitMismatchedCreateIntent: async (scenario: CreateScenarioName) => {
    const fixture = requireCreateFixture();
    const rawWith8636: ExpenseCreateIntent = {
      ...fixture.command,
      operation: { ...fixture.command.operation, operation_id: "fixture-op-mismatch" },
      target: { ...fixture.command.target, entity_id: "fixture-mismatch" },
      payload: { ...fixture.command.payload, amount_cents: 8636 },
    };
    const canonWith8635 = canonicalizeControlDocument({
      ...rawWith8636,
      payload: { ...rawWith8636.payload, amount_cents: 8635 },
    });
    return bridge.submitExpenseCreate({
      scenario,
      rawCommandJson: JSON.stringify(rawWith8636),
      canonicalIntentJson: canonWith8635,
      faultMode: "none",
    });
  },
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
    const fixtureResponse = await fetch("./p1-desktop-expense-create.json");
    if (!fixtureResponse.ok) {
      throw new Error(`Failed to load desktop create fixture: ${fixtureResponse.status}`);
    }
    desktopCreateFixture = (await fixtureResponse.json()) as DesktopCreateFixture;
    const state = await refreshState();
    const createState = await bridge.inspectCreateState({ scenario: currentCreateScenario() });
    renderCreateState(createState);
    runtimeEl.textContent = `Android原生桥已就绪（PID ${state.callerPid}）`;
    setControlsEnabled(true);
  } catch (error) {
    runtimeEl.textContent = "原生桥初始化失败";
    errorEl.textContent = error instanceof Error ? error.message : String(error);
  }
}

void init();
