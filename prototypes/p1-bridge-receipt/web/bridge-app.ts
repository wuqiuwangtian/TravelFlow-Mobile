import { Capacitor, registerPlugin } from "./capacitor-core.js";
import { summarizeLedger } from "./ledger-core.js";
import {
  MAX_AMOUNT_CENTS,
  OFFLINE_BASELINE_SOURCE,
  OFFLINE_BRANCH_ID,
  OFFLINE_DATASET_ID,
  OFFLINE_DEVICE_ID,
  OFFLINE_INITIAL_REVISION_ID,
  OFFLINE_TRAVEL_ID,
  type ExpenseCreateIntent,
  type ExpensePatchIntent,
  type ReceiptLookupIntent,
  buildExpensePatchIntent,
  buildOfflineExpenseCreateIntent,
  buildReceiptLookupIntent,
  canonicalizeControlDocument,
  canonicalizeQueryDocument,
  formatCentsToYuan,
  parseDecimalYuanToCents,
  parseStrictAmountCents,
  validateExpenseCreateAmount,
  validateExpenseNotes,
  validateExpenseTitle,
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
  | "create-conflict-share"
  | "create-boundary-fields-scope"
  | "create-boundary-over-20"
  | "create-boundary-cap-2000"
  | "create-pending-ec10"
  | "create-pending-ec10-saved"
  | "create-pending-ec07";

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
  datasetId: string;
  sourceDeviceId: string;
  expectedRevisionId: string;
  rawCommandJson: string;
  canonicalIntentJson: string;
  intentSha256: string;
  recoveryState: string;
  lastError: string | null;
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
  budget_item_id: string | null;
  settles_budget: boolean;
}

interface CreateInspectStateResult {
  seeded: boolean;
  headRevisionId: string | null;
  expenseCount: number;
  totalCents: number;
  pageOffset: number;
  pageLimit: number;
  hasMoreExpenses: boolean;
  expenses: CreateExpenseRow[];
  revisions: Array<{
    revision_id: string;
    parent_revision_id: string | null;
    expense_count: number;
    total_cents: number;
    snapshot_sha256: string;
    snapshot?: { expenses: CreateExpenseRow[] };
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
    initialCount?: number;
  }): Promise<CreateInspectStateResult>;
  saveCreatePendingIntent(options: {
    scenario: CreateScenarioName;
    operationId: string;
    rawCommandJson: string;
    canonicalIntentJson: string;
    recoveryState?: string;
  }): Promise<CreatePendingStateResult>;
  updateCreatePendingStatus(options: {
    scenario: CreateScenarioName;
    operationId: string;
    recoveryState: string;
    lastError: string | null;
  }): Promise<CreatePendingStateResult>;
  holdCreateWriterLock(options: { scenario: CreateScenarioName }): Promise<{ writerPid: number; callerPid: number }>;
  releaseCreateWriterLock(options: { scenario: CreateScenarioName }): Promise<{ writerPid: number; callerPid: number }>;
  loadCreatePendingIntent(options: { scenario: CreateScenarioName }): Promise<CreatePendingStateResult>;
  confirmCreatePendingIntent(options: {
    scenario: CreateScenarioName;
    operationId: string;
    revisionId: string;
  }): Promise<CreatePendingStateResult>;
  submitExpenseCreate(options: {
    scenario: CreateScenarioName;
    principal: SyntheticPrincipal;
    rawCommandJson: string;
    canonicalIntentJson: string;
    faultMode: FaultMode;
  }): Promise<CreateExecuteResult>;
  submitCreateNotesPatch(options: {
    scenario: CreateScenarioName;
    principal: SyntheticPrincipal;
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
  inspectCreateState(options: {
    scenario: CreateScenarioName;
    pageOffset?: number;
    pageLimit?: number;
  }): Promise<CreateInspectStateResult>;
  readCreateRevisionPage(options: {
    scenario: CreateScenarioName;
    revisionId: string;
    offset?: number;
    limit?: number;
  }): Promise<{
    accepted: boolean;
    error?: string;
    revision_id?: string;
    parent_revision_id?: string | null;
    expense_count?: number;
    total_cents?: number;
    snapshot_sha256?: string;
    offset?: number;
    limit?: number;
    has_more?: boolean;
    expenses?: CreateExpenseRow[];
  }>;
  initOfflineTripLedger(options: {
    datasetId: string;
    travelId: string;
    branchId: string;
    initialRevisionId: string;
    baselineSource: string;
  }): Promise<OfflineTripLedgerState>;
  saveOfflineTripExpense(options: {
    rawCommandJson: string;
    canonicalIntentJson: string;
  }): Promise<OfflineTripSaveResult>;
  confirmOfflineDelivery(options: { operationId: string; response: unknown }): Promise<{ accepted: boolean }>;
  receiveDesktopCommand(options: { raw: string }): Promise<unknown>;
  inspectOfflineTripLedger(): Promise<OfflineTripLedgerState>;
  exportOfflineOutboxCommands(): Promise<OfflineOutboxExportResult>;
}

interface OfflineTripExpenseRow extends CreateExpenseRow {
  desktop_revision_id: string | null;
  operation_id: string;
  delivery_state: string;
  expected_revision_id: string | null;
  result_revision_id: string | null;
  intent_sha256: string | null;
}

interface OfflineTripOutboxItem {
  seq: number;
  dataset_id: string;
  source_device_id: string;
  operation_id: string;
  entity_id: string;
  expected_revision_id: string;
  result_revision_id: string;
  raw_command_json: string;
  command: ExpenseCreateIntent;
  canonical_intent_json: string;
  intent_sha256: string;
  delivery_state: string;
  receipt_query: ReceiptLookupIntent;
}

interface OfflineTripLedgerState {
  syncedDesktopRevisionId?: string | null;
  initialized: boolean;
  callerPid: number;
  datasetId?: string;
  travelId?: string;
  branchId?: string;
  headRevisionId?: string;
  baselineSource?: string;
  expenseCount: number;
  totalCents: number;
  revisionCount: number;
  receiptCount: number;
  outboxCount: number;
  expenses: OfflineTripExpenseRow[];
  revisions: Array<{
    revision_id: string;
    parent_revision_id: string | null;
    expense_count: number;
    total_cents: number;
    snapshot_sha256: string;
  }>;
  outbox: OfflineTripOutboxItem[];
  journal?: string;
  sqlite?: string;
}

interface OfflineTripSaveResult {
  accepted: boolean;
  replayed?: boolean;
  operation_id?: string;
  entity_id?: string;
  expected_revision_id?: string;
  result_revision_id?: string;
  intent_sha256?: string;
  delivery_state?: string;
  error?: string;
}

interface OfflineOutboxExportResult {
  contract_id: string;
  contract_version: string;
  initialized: boolean;
  dataset_id?: string;
  travel_id?: string;
  branch_id?: string;
  head_revision_id?: string;
  baseline_source?: string;
  count: number;
  items: OfflineTripOutboxItem[];
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
const createPaidOnEl = byId<HTMLInputElement>("create-paid-on");
const createFaultModeEl = byId<HTMLSelectElement>("create-fault-mode");
const createLedgerEl = byId<HTMLParagraphElement>("create-ledger");
const createPendingStateEl = byId<HTMLParagraphElement>("create-pending-state");
const createPageInfoEl = byId<HTMLParagraphElement>("create-page-info");
const createStatusEl = byId<HTMLParagraphElement>("create-status");

const tripLedgerViewEl = byId<HTMLDivElement>("trip-ledger-view");
const tripEntryViewEl = byId<HTMLDivElement>("trip-entry-view");
const tripMetaEl = byId<HTMLParagraphElement>("trip-meta");
const tripSummaryEl = byId<HTMLParagraphElement>("trip-summary");
const tripSyncStatusEl = byId<HTMLParagraphElement>("trip-sync-status");
const tripExpenseEmptyEl = byId<HTMLDivElement>("trip-expense-empty");
const tripExpenseListEl = byId<HTMLUListElement>("trip-expense-list");
const tripOpenEntryBtn = byId<HTMLButtonElement>("trip-open-entry-btn");
const tripEntryContextEl = byId<HTMLParagraphElement>("trip-entry-context");
const tripEntryTitleEl = byId<HTMLInputElement>("trip-entry-title");
const tripEntryAmountYuanEl = byId<HTMLInputElement>("trip-entry-amount-yuan");
const tripEntryCategoryEl = byId<HTMLSelectElement>("trip-entry-category");
const tripEntryNotesEl = byId<HTMLInputElement>("trip-entry-notes");
const tripEntryErrorEl = byId<HTMLParagraphElement>("trip-entry-error");
const tripEntrySaveBtn = byId<HTMLButtonElement>("trip-entry-save-btn");
const tripEntryCancelBtn = byId<HTMLButtonElement>("trip-entry-cancel-btn");

const CATEGORY_LABELS: Record<string, string> = {
  meal: "餐饮",
  transport: "交通",
  lodging: "住宿",
  ticket: "门票",
  shopping: "购物",
  other: "其他",
};

let offlineSourceDevice: string = OFFLINE_DEVICE_ID;
let currentTripState: OfflineTripLedgerState | null = null;
let tripSaveInFlight = false;
let tripDraftOperationId: string | null = null;
let tripDraftEntityId: string | null = null;
let tripSaveAttemptSeq = 0;
let tripLastAttempt: {
  seq: number;
  outcome: "idle" | "in_flight" | "validation_error" | "save_error" | "saved";
  error: string | null;
  operationId: string | null;
  resultRevisionId: string | null;
} = {
  seq: 0,
  outcome: "idle",
  error: null,
  operationId: null,
  resultRevisionId: null,
};

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
  "create-prepare-pending",
  "create-submit",
  "create-lookup-only",
  "create-recover",
  "create-advance-head",
  "create-replay",
  "create-check-rejections",
  "create-check-auth",
  "create-page-prev",
  "create-page-next",
] as const;

let lastOutcome: Record<string, unknown> | null = null;
let lastState: InspectStateResult | null = null;
let lastCreateOutcome: Record<string, unknown> | null = null;
let desktopCreateFixture: DesktopCreateFixture | null = null;
let createPageOffset = 0;
const CREATE_PAGE_LIMIT = 20;

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
  createPaidOnEl.disabled = !enabled;
  createFaultModeEl.disabled = !enabled;
  for (const id of buttonIds) {
    byId<HTMLButtonElement>(id).disabled = !enabled;
  }
  for (const id of createButtonIds) {
    byId<HTMLButtonElement>(id).disabled = !enabled;
  }
  tripOpenEntryBtn.disabled = !enabled;
  tripEntryTitleEl.disabled = !enabled;
  tripEntryAmountYuanEl.disabled = !enabled;
  tripEntryCategoryEl.disabled = !enabled;
  tripEntryNotesEl.disabled = !enabled;
  tripEntrySaveBtn.disabled = !enabled || tripSaveInFlight;
  tripEntryCancelBtn.disabled = !enabled;
}

function buildCurrentCreateCommand(): ExpenseCreateIntent {
  const fixture = requireCreateFixture();
  const paidOnRaw = createPaidOnEl.value.trim();
  return {
    ...fixture.command,
    payload: {
      ...fixture.command.payload,
      paid_on: paidOnRaw.length > 0 ? paidOnRaw : null,
    },
  };
}

async function recordUnsupportedCreate(scenario: CreateScenarioName, operationId: string): Promise<void> {
  await bridge.updateCreatePendingStatus({
    scenario,
    operationId,
    recoveryState: "blocked_unsupported_capability",
    lastError: "unsupported_capability",
  });
}

function renderCreateState(state: CreateInspectStateResult): void {
  if (!state.seeded) {
    createLedgerEl.textContent = `新增场景 ${currentCreateScenario()} 尚未初始化`;
    createPendingStateEl.textContent = "本机待发送：无";
    createPageInfoEl.textContent = "明细分页：无数据";
    return;
  }
  const pageSummary = summarizeLedger({
    expenses: state.expenses.map((item) => ({ id: item.id, amount_cents: item.amount_cents })),
    adjustments: [],
  });
  if (state.expenseCount === state.expenses.length && pageSummary.paid_cents !== state.totalCents) {
    throw new Error("Native/TS create ledger total mismatch");
  }
  createPageOffset = state.pageOffset;
  createLedgerEl.textContent =
    `空账本场景 ${currentCreateScenario()} · 头版本 ${state.headRevisionId} · 消费 ${state.expenseCount} 笔` +
    `（合计 ¥${(state.totalCents / 100).toFixed(2)}）· 修订 ${state.revisionCount} · 回执 ${state.receiptCount} · 待发送 ${state.outboxCount}`;
  if (state.pending) {
    const parsedCmd = JSON.parse(state.pending.rawCommandJson) as ExpenseCreateIntent;
    const isVerificationState =
      state.pending.recoveryState === "pending_verification" ||
      state.pending.recoveryState === "pending_busy" ||
      state.pending.recoveryState === "intent_conflict";
    const statusLabel = isVerificationState
      ? "提交结果待核实（未确认）"
      : "本机待发送（未发送／未入账）";
    createPendingStateEl.textContent =
      `${statusLabel}：操作 ${state.pending.operationId}` +
      ` · 状态 ${state.pending.recoveryState}` +
      ` · 金额 ${parsedCmd.payload.amount_cents} 分` +
      ` · 付款日 ${parsedCmd.payload.paid_on ?? "null"}` +
      ` · 基线 ${state.pending.expectedRevisionId}`;
  } else if (state.confirmedOp) {
    createPendingStateEl.textContent =
      `已确认入账：操作 ${state.confirmedOp} · 版本 ${state.confirmedRevisionId}`;
  } else {
    createPendingStateEl.textContent = "本机待发送：无";
  }
  const start = state.expenseCount === 0 ? 0 : state.pageOffset + 1;
  const end = state.pageOffset + state.expenses.length;
  createPageInfoEl.textContent =
    `明细分页：第 ${start}-${end} / 共 ${state.expenseCount} 笔 · 本页 ${state.expenses.length} 笔（¥${(pageSummary.paid_cents / 100).toFixed(2)}）`;
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
    createPageOffset = 0;
    const state = await bridge.inspectCreateState({
      scenario: currentCreateScenario(),
      pageOffset: 0,
      pageLimit: CREATE_PAGE_LIMIT,
    });
    renderCreateState(state);
    return { status: "switched", state };
  });
};

byId<HTMLButtonElement>("create-page-prev").onclick = () =>
  void runCreateAction("上一页明细", async () => {
    const nextOffset = Math.max(0, createPageOffset - CREATE_PAGE_LIMIT);
    const state = await bridge.inspectCreateState({
      scenario: currentCreateScenario(),
      pageOffset: nextOffset,
      pageLimit: CREATE_PAGE_LIMIT,
    });
    renderCreateState(state);
    return { status: "paged", state };
  });

byId<HTMLButtonElement>("create-page-next").onclick = () =>
  void runCreateAction("下一页明细", async () => {
    const nextOffset = createPageOffset + CREATE_PAGE_LIMIT;
    const state = await bridge.inspectCreateState({
      scenario: currentCreateScenario(),
      pageOffset: nextOffset,
      pageLimit: CREATE_PAGE_LIMIT,
    });
    renderCreateState(state);
    return { status: "paged", state };
  });

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

byId<HTMLButtonElement>("create-prepare-pending").onclick = () =>
  void runCreateAction("仅保存待发送新增意图", async () => {
    const scenario = currentCreateScenario();
    const cmd = buildCurrentCreateCommand();
    const rawCommandJson = JSON.stringify(cmd);
    const canonicalIntentJson = canonicalizeControlDocument(cmd);
    const saved = await bridge.saveCreatePendingIntent({
      scenario,
      operationId: cmd.operation.operation_id,
      rawCommandJson,
      canonicalIntentJson,
      recoveryState: "pending_unsent",
    });
    const state = await bridge.inspectCreateState({ scenario });
    renderCreateState(state);
    return { status: "prepared", pending: saved.pending, state };
  });

byId<HTMLButtonElement>("create-submit").onclick = () =>
  void runCreateAction("提交固定新增午餐", async () => {
    const scenario = currentCreateScenario();
    const faultMode = currentCreateFaultMode();
    const cmd = buildCurrentCreateCommand();
    const rawCommandJson = JSON.stringify(cmd);
    const canonicalIntentJson = canonicalizeControlDocument(cmd);
    await bridge.saveCreatePendingIntent({
      scenario,
      operationId: cmd.operation.operation_id,
      rawCommandJson,
      canonicalIntentJson,
      recoveryState: "pending_verification",
    });
    const result = await bridge.submitExpenseCreate({
      scenario,
      principal: SYNTHETIC_PRINCIPAL,
      rawCommandJson,
      canonicalIntentJson,
      faultMode,
    });
    if (result.accepted && result.result_revision_id) {
      await bridge.confirmCreatePendingIntent({
        scenario,
        operationId: cmd.operation.operation_id,
        revisionId: result.result_revision_id,
      });
    } else if (result.error === "unsupported_capability") {
      await recordUnsupportedCreate(scenario, cmd.operation.operation_id);
    }
    const state = await bridge.inspectCreateState({ scenario });
    renderCreateState(state);
    return { status: result.accepted ? "committed" : (result.error ?? "rejected"), result, state };
  });

byId<HTMLButtonElement>("create-lookup-only").onclick = () =>
  void runCreateAction("仅核实新增回执", async () => {
    const scenario = currentCreateScenario();
    const callerState = await bridge.loadCreatePendingIntent({ scenario });
    const pending = callerState.pending;
    if (!pending) {
      const state = await bridge.inspectCreateState({ scenario });
      renderCreateState(state);
      return { status: callerState.confirmedOp ? "already_confirmed" : "idle", state };
    }
    const lookup = await bridge.lookupCreateReceipt({
      scenario,
      datasetId: pending.datasetId,
      sourceDeviceId: pending.sourceDeviceId,
      operationId: pending.operationId,
      canonicalIntentJson: pending.canonicalIntentJson,
      principal: SYNTHETIC_PRINCIPAL,
    });
    if (!lookup.accepted && lookup.error === "intent_conflict") {
      await bridge.updateCreatePendingStatus({
        scenario,
        operationId: pending.operationId,
        recoveryState: "intent_conflict",
        lastError: lookup.error,
      });
    } else if (lookup.state === "pending_busy") {
      if (pending.recoveryState !== "blocked_unsupported_capability") {
        await bridge.updateCreatePendingStatus({
          scenario,
          operationId: pending.operationId,
          recoveryState: "pending_busy",
          lastError: "pending_busy",
        });
      }
    } else if (lookup.state === "not_found_at_settled_read") {
      // 能力阻断记录在手动查询缺失时必须保留原阻断原因，不得改写为可重试状态。
      if (pending.recoveryState !== "blocked_unsupported_capability") {
        await bridge.updateCreatePendingStatus({
          scenario,
          operationId: pending.operationId,
          recoveryState: "pending_not_found",
          lastError: null,
        });
      }
    }
    const state = await bridge.inspectCreateState({ scenario });
    renderCreateState(state);
    return { status: lookup.accepted ? (lookup.state ?? "ok") : (lookup.error ?? "rejected"), lookup, state };
  });

byId<HTMLButtonElement>("create-recover").onclick = () =>
  void runCreateAction("查询并恢复新增消费", async () => {
    const scenario = currentCreateScenario();
    const faultMode = currentCreateFaultMode();
    const callerState = await bridge.loadCreatePendingIntent({ scenario });
    const pending = callerState.pending;
    if (!pending) {
      const state = await bridge.inspectCreateState({ scenario });
      renderCreateState(state);
      return { status: callerState.confirmedOp ? "already_confirmed" : "idle", state };
    }
    if (pending.recoveryState === "blocked_unsupported_capability") {
      // 能力不匹配阻断的输入不得自动裁剪字段重发，保持本机待发送状态。
      const state = await bridge.inspectCreateState({ scenario });
      renderCreateState(state);
      return { status: "blocked_unsupported_capability", pending, state };
    }
    const lookup = await bridge.lookupCreateReceipt({
      scenario,
      datasetId: pending.datasetId,
      sourceDeviceId: pending.sourceDeviceId,
      operationId: pending.operationId,
      canonicalIntentJson: pending.canonicalIntentJson,
      principal: SYNTHETIC_PRINCIPAL,
    });
    if (!lookup.accepted) {
      if (lookup.error === "intent_conflict") {
        await bridge.updateCreatePendingStatus({
          scenario,
          operationId: pending.operationId,
          recoveryState: "intent_conflict",
          lastError: lookup.error,
        });
        const state = await bridge.inspectCreateState({ scenario });
        renderCreateState(state);
        return { status: "intent_conflict", lookup, state };
      }
      throw new Error(`Receipt lookup rejected: ${lookup.error}`);
    }
    if (lookup.state === "pending_busy") {
      await bridge.updateCreatePendingStatus({
        scenario,
        operationId: pending.operationId,
        recoveryState: "pending_busy",
        lastError: "pending_busy",
      });
      const state = await bridge.inspectCreateState({ scenario });
      renderCreateState(state);
      return { status: "pending_busy", lookup, state };
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
      // 重试提交前先持久标记为结果待核实，避免丢应答重开后仍显示旧的未查到状态。
      await bridge.updateCreatePendingStatus({
        scenario,
        operationId: pending.operationId,
        recoveryState: "pending_verification",
        lastError: null,
      });
      const retry = await bridge.submitExpenseCreate({
        scenario,
        principal: SYNTHETIC_PRINCIPAL,
        rawCommandJson: pending.rawCommandJson,
        canonicalIntentJson: pending.canonicalIntentJson,
        faultMode,
      });
      if (retry.error === "unsupported_capability") {
        await recordUnsupportedCreate(scenario, pending.operationId);
        const state = await bridge.inspectCreateState({ scenario });
        renderCreateState(state);
        return { status: retry.error, result: retry, lookup, state };
      }
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
        datasetId: pending.datasetId,
        sourceDeviceId: pending.sourceDeviceId,
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
      principal: SYNTHETIC_PRINCIPAL,
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
      principal: SYNTHETIC_PRINCIPAL,
      rawCommandJson: JSON.stringify(fixture.command),
      canonicalIntentJson: originalCanon,
      faultMode: "none",
    });
    const replayReordered = await bridge.submitExpenseCreate({
      scenario,
      principal: SYNTHETIC_PRINCIPAL,
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
      principal: SYNTHETIC_PRINCIPAL,
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
      principal: SYNTHETIC_PRINCIPAL,
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
      principal: SYNTHETIC_PRINCIPAL,
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
      principal: SYNTHETIC_PRINCIPAL,
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
        principal: SYNTHETIC_PRINCIPAL,
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
  inspectCreateState: (scenario: CreateScenarioName, pageOffset = 0, pageLimit = CREATE_PAGE_LIMIT) =>
    bridge.inspectCreateState({ scenario, pageOffset, pageLimit }),
  readCreateRevisionPage: (scenario: CreateScenarioName, revisionId: string, offset = 0, limit = CREATE_PAGE_LIMIT) =>
    bridge.readCreateRevisionPage({ scenario, revisionId, offset, limit }),
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
      principal: SYNTHETIC_PRINCIPAL,
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
      principal: SYNTHETIC_PRINCIPAL,
      rawCommandJson: JSON.stringify(rawWith8636),
      canonicalIntentJson: canonWith8635,
      faultMode: "none",
    });
  },
  runCreateBoundaryFieldsAndScope: async () => {
    const scenario: CreateScenarioName = "create-boundary-fields-scope";
    const fixture = requireCreateFixture();
    await bridge.seedCreateScenario({
      scenario,
      datasetId: fixture.command.operation.dataset_id,
      travelId: fixture.command.target.travel_id,
      branchId: fixture.command.target.branch_id,
      initialRevisionId: fixture.command.expected_revision_id,
    });

    const fieldCases: Array<{ label: string; patch: Record<string, unknown>; result: CreateExecuteResult }> = [];
    for (const [label, patch] of [
      ["paid_on", { paid_on: "2026-11-24" }],
      ["day", { day: 1 }],
      ["activity_id", { activity_id: "fixture-act-1" }],
      ["receipt_ids", { receipt_ids: ["fixture-rcpt-1"] }],
      ["budget_item_id", { budget_item_id: "fixture-budget-1" }],
      ["settles_budget", { settles_budget: true }],
      ["category", { category: "flight" }],
      ["currency", { currency: "USD" }],
    ] as Array<[string, Record<string, unknown>]>) {
      const cmd = {
        ...fixture.command,
        operation: { ...fixture.command.operation, operation_id: `fixture-op-field-${label}` },
        payload: { ...fixture.command.payload, ...patch },
      } as ExpenseCreateIntent;
      const result = await bridge.submitExpenseCreate({
        scenario,
        principal: SYNTHETIC_PRINCIPAL,
        rawCommandJson: JSON.stringify(cmd),
        canonicalIntentJson: canonicalizeControlDocument(cmd),
        faultMode: "none",
      });
      fieldCases.push({ label, patch, result });
    }

    const identityCases: Array<{ label: string; result: CreateExecuteResult }> = [];
    for (const [label, principalOverride] of [
      ["unauthenticated", { authenticated: false }],
      ["no_write_permission", { can_write: false }],
      ["wrong_dataset", { dataset_id: "fixture-other-dataset" }],
      ["wrong_device", { source_device_id: "fixture-other-device" }],
    ] as Array<[string, Partial<SyntheticPrincipal>]>) {
      const cmd = {
        ...fixture.command,
        operation: { ...fixture.command.operation, operation_id: `fixture-op-auth-${label}` },
      };
      const result = await bridge.submitExpenseCreate({
        scenario,
        principal: { ...SYNTHETIC_PRINCIPAL, ...principalOverride },
        rawCommandJson: JSON.stringify(cmd),
        canonicalIntentJson: canonicalizeControlDocument(cmd),
        faultMode: "none",
      });
      identityCases.push({ label, result });
    }

    const scopeCases: Array<{ label: string; result: CreateExecuteResult }> = [];
    for (const [label, targetOverride] of [
      ["wrong_travel", { travel_id: "fixture-other-travel" }],
      ["wrong_branch", { branch_id: "fixture-other-branch" }],
    ] as Array<[string, Record<string, string>]>) {
      const cmd = {
        ...fixture.command,
        operation: { ...fixture.command.operation, operation_id: `fixture-op-scope-${label}` },
        target: { ...fixture.command.target, ...targetOverride },
      };
      const result = await bridge.submitExpenseCreate({
        scenario,
        principal: SYNTHETIC_PRINCIPAL,
        rawCommandJson: JSON.stringify(cmd),
        canonicalIntentJson: canonicalizeControlDocument(cmd),
        faultMode: "none",
      });
      scopeCases.push({ label, result });
    }

    const stateAfterRejections = await bridge.inspectCreateState({ scenario });
    const validCommit = await bridge.submitExpenseCreate({
      scenario,
      principal: SYNTHETIC_PRINCIPAL,
      rawCommandJson: JSON.stringify(fixture.command),
      canonicalIntentJson: canonicalizeControlDocument(fixture.command),
      faultMode: "none",
    });
    const stateAfterValid = await bridge.inspectCreateState({ scenario });

    // Reused create operation_id targeting wrong travel/branch must be rejected by scope BEFORE receipt lookup.
    const usedCreateScopeCases: Array<{ label: string; result: CreateExecuteResult }> = [];
    for (const [label, targetOverride] of [
      ["used_create_wrong_travel", { travel_id: "fixture-other-travel" }],
      ["used_create_wrong_branch", { branch_id: "fixture-other-branch" }],
    ] as Array<[string, Record<string, string>]>) {
      const cmd = {
        ...fixture.command,
        target: { ...fixture.command.target, ...targetOverride },
      };
      const result = await bridge.submitExpenseCreate({
        scenario,
        principal: SYNTHETIC_PRINCIPAL,
        rawCommandJson: JSON.stringify(cmd),
        canonicalIntentJson: canonicalizeControlDocument(cmd),
        faultMode: "none",
      });
      usedCreateScopeCases.push({ label, result });
    }

    // Notes patch: new key targeting wrong travel/branch must be rejected before receipt lookup.
    const baseNotesPatch: ExpensePatchIntent = {
      profile: fixture.command.profile,
      kind: "expense.patch",
      operation: { ...fixture.command.operation, operation_id: "fixture-op-notes" },
      target: { ...fixture.command.target },
      expected_revision_id: validCommit.result_revision_id ?? "fixture-r0",
      payload: { notes: "虚构更正" },
    };
    const newPatchScopeCases: Array<{ label: string; result: CreateExecuteResult }> = [];
    for (const [label, targetOverride] of [
      ["new_patch_wrong_travel", { travel_id: "fixture-other-travel" }],
      ["new_patch_wrong_branch", { branch_id: "fixture-other-branch" }],
    ] as Array<[string, Record<string, string>]>) {
      const cmd: ExpensePatchIntent = {
        ...baseNotesPatch,
        operation: { ...baseNotesPatch.operation, operation_id: `fixture-op-${label}` },
        target: { ...baseNotesPatch.target, ...targetOverride },
      };
      const result = await bridge.submitCreateNotesPatch({
        scenario,
        principal: SYNTHETIC_PRINCIPAL,
        rawCommandJson: JSON.stringify(cmd),
        canonicalIntentJson: canonicalizeControlDocument(cmd),
      });
      newPatchScopeCases.push({ label, result });
    }

    const validNotesPatch = await bridge.submitCreateNotesPatch({
      scenario,
      principal: SYNTHETIC_PRINCIPAL,
      rawCommandJson: JSON.stringify(baseNotesPatch),
      canonicalIntentJson: canonicalizeControlDocument(baseNotesPatch),
    });

    // Already-used notes patch key targeting wrong travel/branch must also reject with scope_mismatch before receipt lookup.
    const usedPatchScopeCases: Array<{ label: string; result: CreateExecuteResult }> = [];
    for (const [label, targetOverride] of [
      ["used_patch_wrong_travel", { travel_id: "fixture-other-travel" }],
      ["used_patch_wrong_branch", { branch_id: "fixture-other-branch" }],
    ] as Array<[string, Record<string, string>]>) {
      const cmd: ExpensePatchIntent = {
        ...baseNotesPatch,
        target: { ...baseNotesPatch.target, ...targetOverride },
      };
      const result = await bridge.submitCreateNotesPatch({
        scenario,
        principal: SYNTHETIC_PRINCIPAL,
        rawCommandJson: JSON.stringify(cmd),
        canonicalIntentJson: canonicalizeControlDocument(cmd),
      });
      usedPatchScopeCases.push({ label, result });
    }

    const stateFinal = await bridge.inspectCreateState({ scenario });
    renderCreateState(stateFinal);
    return {
      fieldCases,
      identityCases,
      scopeCases,
      stateAfterRejections,
      validCommit,
      stateAfterValid,
      usedCreateScopeCases,
      newPatchScopeCases,
      validNotesPatch,
      usedPatchScopeCases,
      stateFinal,
    };
  },
  seedAndCommitCreateCount: async (scenario: CreateScenarioName, initialCount: number, initialRevisionId: string) => {
    const fixture = requireCreateFixture();
    const seeded = await bridge.seedCreateScenario({
      scenario,
      datasetId: fixture.command.operation.dataset_id,
      travelId: fixture.command.target.travel_id,
      branchId: fixture.command.target.branch_id,
      initialRevisionId,
      initialCount,
    });
    const cmdNext: ExpenseCreateIntent = {
      ...fixture.command,
      expected_revision_id: initialRevisionId,
    };
    const commitNext = await bridge.submitExpenseCreate({
      scenario,
      principal: SYNTHETIC_PRINCIPAL,
      rawCommandJson: JSON.stringify(cmdNext),
      canonicalIntentJson: canonicalizeControlDocument(cmdNext),
      faultMode: "none",
    });
    const stateAfterCommit = await bridge.inspectCreateState({ scenario, pageOffset: 0, pageLimit: CREATE_PAGE_LIMIT });
    renderCreateState(stateAfterCommit);
    return { seeded, commitNext, stateAfterCommit };
  },
  checkCreatePostRestartGuards: async (
    scenario: CreateScenarioName,
    initialRevisionId: string,
    committedRevId: string,
    expectCapReject: boolean,
  ) => {
    const fixture = requireCreateFixture();
    const cmdOrig: ExpenseCreateIntent = {
      ...fixture.command,
      expected_revision_id: initialRevisionId,
    };
    const canonOrig = canonicalizeControlDocument(cmdOrig);

    const newOpCmd: ExpenseCreateIntent = {
      ...fixture.command,
      operation: { ...fixture.command.operation, operation_id: "fixture-op-extra" },
      target: {
        ...fixture.command.target,
        entity_id: expectCapReject ? "fixture-expense-2001" : fixture.command.target.entity_id,
      },
      expected_revision_id: committedRevId,
    };
    const rejectNew = await bridge.submitExpenseCreate({
      scenario,
      principal: SYNTHETIC_PRINCIPAL,
      rawCommandJson: JSON.stringify(newOpCmd),
      canonicalIntentJson: canonicalizeControlDocument(newOpCmd),
      faultMode: "none",
    });

    const reorderedOrig = {
      ...Object.fromEntries(Object.entries(cmdOrig).reverse()),
      payload: Object.fromEntries(Object.entries(cmdOrig.payload).reverse()),
    } as ExpenseCreateIntent;
    const replayOriginal = await bridge.submitExpenseCreate({
      scenario,
      principal: SYNTHETIC_PRINCIPAL,
      rawCommandJson: JSON.stringify(cmdOrig),
      canonicalIntentJson: canonOrig,
      faultMode: "none",
    });
    const replayReordered = await bridge.submitExpenseCreate({
      scenario,
      principal: SYNTHETIC_PRINCIPAL,
      rawCommandJson: JSON.stringify(reorderedOrig),
      canonicalIntentJson: canonicalizeControlDocument(reorderedOrig),
      faultMode: "none",
    });

    const conflictCmd: ExpenseCreateIntent = {
      ...cmdOrig,
      payload: { ...cmdOrig.payload, amount_cents: 8636 },
    };
    const conflictResult = await bridge.submitExpenseCreate({
      scenario,
      principal: SYNTHETIC_PRINCIPAL,
      rawCommandJson: JSON.stringify(conflictCmd),
      canonicalIntentJson: canonicalizeControlDocument(conflictCmd),
      faultMode: "none",
    });

    const stateFinal = await bridge.inspectCreateState({ scenario, pageOffset: 0, pageLimit: CREATE_PAGE_LIMIT });
    renderCreateState(stateFinal);
    return { rejectNew, replayOriginal, replayReordered, conflictResult, stateFinal };
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
  holdCreateWriterLock: (scenario: CreateScenarioName) => bridge.holdCreateWriterLock({ scenario }),
  releaseCreateWriterLock: (scenario: CreateScenarioName) => bridge.releaseCreateWriterLock({ scenario }),
};

function setTripEntryError(message: string | null): void {
  if (!message) {
    tripEntryErrorEl.textContent = "";
    tripEntryErrorEl.classList.add("hidden");
  } else {
    tripEntryErrorEl.textContent = message;
    tripEntryErrorEl.classList.remove("hidden");
  }
}

function showTripLedgerView(): void {
  tripEntryViewEl.classList.add("hidden");
  tripLedgerViewEl.classList.remove("hidden");
  setTripEntryError(null);
}

function openTripEntryForm(): void {
  const travelId = currentTripState?.travelId ?? OFFLINE_TRAVEL_ID;
  const branchId = currentTripState?.branchId ?? OFFLINE_BRANCH_ID;
  const headRevisionId = currentTripState?.headRevisionId ?? OFFLINE_INITIAL_REVISION_ID;
  tripDraftOperationId = `op-${crypto.randomUUID()}`;
  tripDraftEntityId = `exp-${crypto.randomUUID()}`;
  tripEntryTitleEl.value = "";
  tripEntryAmountYuanEl.value = "";
  tripEntryCategoryEl.value = "meal";
  tripEntryNotesEl.value = "";
  tripEntryContextEl.textContent = `旅行 ${travelId} · 分支 ${branchId} · 当前基线 ${headRevisionId}`;
  setTripEntryError(null);
  tripLedgerViewEl.classList.add("hidden");
  tripEntryViewEl.classList.remove("hidden");
}

function renderOfflineTripLedger(state: OfflineTripLedgerState): void {
  currentTripState = state;
  const summary =
    state.expenses.length > 0
      ? summarizeLedger({
          expenses: state.expenses.map((item) => ({ id: item.id, amount_cents: item.amount_cents })),
          adjustments: [],
        })
      : { paid_cents: 0 };
  const totalCents = summary.paid_cents;
  const travelId = state.travelId ?? OFFLINE_TRAVEL_ID;
  const branchId = state.branchId ?? OFFLINE_BRANCH_ID;
  const headRevisionId = state.headRevisionId ?? OFFLINE_INITIAL_REVISION_ID;
  const baselineSource = state.baselineSource ?? OFFLINE_BASELINE_SOURCE;

  tripMetaEl.textContent =
    `虚构旅行 ${travelId} · 分支 ${branchId} · 头版本 ${headRevisionId} · 起始基线 ${state.revisions[0]?.revision_id ?? OFFLINE_INITIAL_REVISION_ID}（来源：${baselineSource}）`;
  tripSummaryEl.textContent = `共 ${state.expenseCount} 笔 · 合计 ¥${formatCentsToYuan(totalCents)}`;

  if (state.outboxCount === 0) {
    tripSyncStatusEl.dataset.tone = "pending";
    if (state.expenseCount > 0) tripSyncStatusEl.textContent = `桌面已确认 · 共 ${state.expenseCount} 笔`;
    else tripSyncStatusEl.textContent = "本机离线账本已就绪 · 暂无待发送记录（不会当作桌面已确认）";
  } else {
    tripSyncStatusEl.dataset.tone = "warning";
    tripSyncStatusEl.textContent = `已在本机保存，待发送 ${state.outboxCount} 笔（本机提交成功，尚未经桌面端确认）`;
  }

  tripExpenseListEl.innerHTML = "";
  if (state.expenses.length === 0) {
    tripExpenseEmptyEl.classList.remove("hidden");
    return;
  }
  tripExpenseEmptyEl.classList.add("hidden");
  for (const item of state.expenses) {
    const li = document.createElement("li");
    li.className = "trip-item";
    li.dataset.entityId = item.id;
    li.dataset.operationId = item.operation_id;
    li.dataset.deliveryState = item.delivery_state;

    const topRow = document.createElement("div");
    topRow.className = "trip-row";

    const titleSpan = document.createElement("span");
    titleSpan.className = "trip-item-title";
    titleSpan.textContent = item.title;

    const amountSpan = document.createElement("span");
    amountSpan.className = "trip-item-title";
    amountSpan.textContent = `¥${formatCentsToYuan(item.amount_cents)}`;

    topRow.append(titleSpan, amountSpan);

    const subRow = document.createElement("div");
    subRow.className = "trip-row trip-item-sub";

    const detailSpan = document.createElement("span");
    const categoryLabel = CATEGORY_LABELS[item.category] ?? item.category;
    const paidOnText = item.paid_on === null ? "未知" : item.paid_on;
    const notesSuffix = item.notes ? ` · 备注：${item.notes}` : "";
    detailSpan.textContent = `类别：${categoryLabel} · 付款日：${paidOnText}${notesSuffix}`;

    const badge = document.createElement("span");
    badge.className = "tf-badge";
    badge.dataset.tone = "amber";
    badge.textContent = item.delivery_state === "confirmed" ? "桌面已确认" : "已在本机保存，待发送";

    subRow.append(detailSpan, badge);
    li.append(topRow, subRow);
    tripExpenseListEl.appendChild(li);
  }
}

tripOpenEntryBtn.addEventListener("click", () => {
  openTripEntryForm();
});

tripEntryCancelBtn.addEventListener("click", () => {
  tripDraftOperationId = null;
  tripDraftEntityId = null;
  showTripLedgerView();
});

tripEntrySaveBtn.addEventListener("click", () => {
  if (tripSaveInFlight) {
    return;
  }
  const attemptSeq = ++tripSaveAttemptSeq;
  tripLastAttempt = {
    seq: attemptSeq,
    outcome: "in_flight",
    error: null,
    operationId: tripDraftOperationId,
    resultRevisionId: null,
  };
  tripSaveInFlight = true;
  tripEntrySaveBtn.disabled = true;
  tripEntrySaveBtn.setAttribute("aria-busy", "true");
  setTripEntryError(null);

  void (async () => {
    try {
      const title = validateExpenseTitle(tripEntryTitleEl.value);
      const amountCents = parseDecimalYuanToCents(tripEntryAmountYuanEl.value);
      const category = tripEntryCategoryEl.value;
      const notes = validateExpenseNotes(tripEntryNotesEl.value);

      const state = currentTripState ?? (await bridge.inspectOfflineTripLedger());
      const datasetId = state.datasetId ?? OFFLINE_DATASET_ID;
      const travelId = state.travelId ?? OFFLINE_TRAVEL_ID;
      const branchId = state.branchId ?? OFFLINE_BRANCH_ID;
      const expectedRevisionId = state.headRevisionId ?? OFFLINE_INITIAL_REVISION_ID;
      const operationId = tripDraftOperationId ?? `op-${crypto.randomUUID()}`;
      const entityId = tripDraftEntityId ?? `exp-${crypto.randomUUID()}`;
      tripDraftOperationId = operationId;
      tripDraftEntityId = entityId;

      const command = buildOfflineExpenseCreateIntent({
        datasetId,
        sourceDeviceId: offlineSourceDevice,
        operationId,
        travelId,
        branchId,
        entityId,
        expectedRevisionId,
        title,
        amountCents,
        category,
        notes,
      });
      const rawCommandJson = JSON.stringify(command);
      const canonicalIntentJson = canonicalizeControlDocument(command);
      const saveResult = await bridge.saveOfflineTripExpense({
        rawCommandJson,
        canonicalIntentJson,
      });
      if (!saveResult.accepted) {
        const msg = `保存失败：${saveResult.error ?? "unknown_error"}`;
        setTripEntryError(msg);
        tripLastAttempt = {
          seq: attemptSeq,
          outcome: "save_error",
          error: msg,
          operationId,
          resultRevisionId: null,
        };
        return;
      }

      const refreshed = await bridge.inspectOfflineTripLedger();
      renderOfflineTripLedger(refreshed);
      tripDraftOperationId = null;
      tripDraftEntityId = null;
      showTripLedgerView();
      tripLastAttempt = {
        seq: attemptSeq,
        outcome: "saved",
        error: null,
        operationId,
        resultRevisionId: saveResult.result_revision_id ?? null,
      };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      setTripEntryError(msg);
      tripLastAttempt = {
        seq: attemptSeq,
        outcome: "validation_error",
        error: msg,
        operationId: tripDraftOperationId,
        resultRevisionId: null,
      };
    } finally {
      tripSaveInFlight = false;
      tripEntrySaveBtn.removeAttribute("aria-busy");
      tripEntrySaveBtn.disabled = false;
    }
  })();
});

(window as unknown as Record<string, unknown>).__travelflowOfflineEntry = {
  inspect: async () => {
    const state = await bridge.inspectOfflineTripLedger();
    renderOfflineTripLedger(state);
    return state;
  },
  receiveDesktopCommand: async (raw: string) => {
    const result = await bridge.receiveDesktopCommand({ raw });
    renderOfflineTripLedger(await bridge.inspectOfflineTripLedger());
    return result;
  },
  confirmDelivery: async (operationId: string, response: unknown) => {
    const result = await bridge.confirmOfflineDelivery({ operationId, response });
    renderOfflineTripLedger(await bridge.inspectOfflineTripLedger());
    return result;
  },
  exportOutboxCommands: () => bridge.exportOfflineOutboxCommands(),
  submitRawCommand: (rawCommand: Record<string, unknown>) =>
    bridge.saveOfflineTripExpense({
      rawCommandJson: JSON.stringify(rawCommand),
      canonicalIntentJson: canonicalizeControlDocument(rawCommand as unknown as ExpenseCreateIntent),
    }),
  submitRawStrings: (rawCommandJson: string, canonicalIntentJson: string) =>
    bridge.saveOfflineTripExpense({ rawCommandJson, canonicalIntentJson }),
  getUiState: () => ({
    ledgerViewVisible: !tripLedgerViewEl.classList.contains("hidden"),
    entryViewVisible: !tripEntryViewEl.classList.contains("hidden"),
    metaText: tripMetaEl.textContent ?? "",
    summaryText: tripSummaryEl.textContent ?? "",
    syncStatusText: tripSyncStatusEl.textContent ?? "",
    errorText: tripEntryErrorEl.classList.contains("hidden") ? "" : (tripEntryErrorEl.textContent ?? ""),
    titleValue: tripEntryTitleEl.value,
    notesValue: tripEntryNotesEl.value,
    saveAttemptSeq: tripSaveAttemptSeq,
    lastAttempt: tripLastAttempt,
    renderedItems: Array.from(tripExpenseListEl.querySelectorAll("li")).map((li) => ({
      entityId: li.dataset.entityId ?? "",
      operationId: li.dataset.operationId ?? "",
      deliveryState: li.dataset.deliveryState ?? "",
      text: li.textContent ?? "",
    })),
  }),
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
    const seedFile = await fetch("./offline-trip-seed.json");
    if (!seedFile.ok) throw new Error("Cannot load isolated trip context");
    const seed = await seedFile.json();
    offlineSourceDevice = seed?.sourceDeviceId ?? OFFLINE_DEVICE_ID;
    const tripState = await bridge.initOfflineTripLedger(seed ?? {
      datasetId: OFFLINE_DATASET_ID,
      travelId: OFFLINE_TRAVEL_ID,
      branchId: OFFLINE_BRANCH_ID,
      initialRevisionId: OFFLINE_INITIAL_REVISION_ID,
      baselineSource: OFFLINE_BASELINE_SOURCE,
    });
    renderOfflineTripLedger(tripState);
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
