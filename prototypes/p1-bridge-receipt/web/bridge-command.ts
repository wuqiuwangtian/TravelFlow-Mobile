// P1 隔离桥接命令构造与规范化编码（对齐 p1-host-control-1 / p1-host-query-1 / p1-host-intent-c14n-1）。
export const CONTROL_PROFILE = "p1-host-control-1" as const;
export const QUERY_PROFILE = "p1-host-query-1" as const;
export const CANONICAL_PROFILE = "p1-host-intent-c14n-1" as const;

export const FIXTURE_DATASET_ID = "fixture-dataset-p1-bridge";
export const FIXTURE_DEVICE_ID = "android-api35-bridge-caller";
export const FIXTURE_TRAVEL_ID = "fixture-travel-1";
export const FIXTURE_BRANCH_ID = "fixture-branch-main";
export const FIXTURE_EXPENSE_ID = "fixture-expense-1";

export const MIN_AMOUNT_CENTS = 1;
export const MAX_AMOUNT_CENTS = 9999999999;

export const OFFLINE_CONTRACT_ID = "travelflow.expense-create" as const;
export const OFFLINE_CONTRACT_VERSION = "0.1.0" as const;
export const OFFLINE_DATASET_ID = "fixture-dataset" as const;
export const OFFLINE_DEVICE_ID = "fixture-device" as const;
export const OFFLINE_TRAVEL_ID = "fixture-travel" as const;
export const OFFLINE_BRANCH_ID = "fixture-branch" as const;
export const OFFLINE_INITIAL_REVISION_ID = "fixture-r0" as const;
export const OFFLINE_BASELINE_SOURCE =
  "vendor/contracts/expense-create-v0.1.0 (fixture-dataset / fixture-travel / fixture-branch / fixture-r0)" as const;

export const EXPENSE_CATEGORIES = ["meal", "transport", "lodging", "ticket", "shopping", "other"] as const;
export type ExpenseCategory = (typeof EXPENSE_CATEGORIES)[number];

export interface OperationIdentity {
  dataset_id: string;
  source_device_id: string;
  operation_id: string;
}

export interface ExpensePatchIntent {
  profile: typeof CONTROL_PROFILE;
  kind: "expense.patch";
  operation: OperationIdentity;
  target: {
    travel_id: string;
    branch_id: string;
    entity_id: string;
  };
  expected_revision_id: string;
  payload: {
    amount_cents?: number;
    notes?: string;
  };
}

export interface ExpenseCreateIntent {
  profile: typeof CONTROL_PROFILE;
  kind: "expense.create";
  operation: OperationIdentity;
  target: {
    travel_id: string;
    branch_id: string;
    entity_id: string;
  };
  expected_revision_id: string;
  payload: {
    title: string;
    amount_cents: number;
    currency: "CNY";
    paid_on: string | null;
    category: string;
    day: number | null;
    activity_id: string | null;
    notes: string;
    receipt_ids: string[];
    allow_shared_receipts: boolean;
    budget_item_id: string | null;
    settles_budget: boolean;
  };
}

export interface ReceiptLookupIntent {
  profile: typeof QUERY_PROFILE;
  kind: "receipt.lookup";
  operation: OperationIdentity;
}

function assertSafeIdentifier(value: string, label: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 128) {
    throw new Error(`Invalid ${label}`);
  }
  return value;
}

function assertAmountCents(value: number): number {
  if (!Number.isSafeInteger(value) || value < MIN_AMOUNT_CENTS || value > MAX_AMOUNT_CENTS) {
    throw new Error("amount_cents must be a safe positive integer within P1 bounds");
  }
  return value;
}

export function parseStrictAmountCents(raw: string): number {
  if (typeof raw !== "string" || !/^[1-9][0-9]*$/.test(raw)) {
    throw new Error(`Invalid amount_cents input: ${String(raw)}`);
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || String(value) !== raw || value < MIN_AMOUNT_CENTS || value > MAX_AMOUNT_CENTS) {
    throw new Error(`amount_cents out of P1 bounds: ${raw}`);
  }
  return value;
}

export function buildExpensePatchIntent(params: {
  operationId: string;
  expectedRevision: number;
  amountCents: number;
  notes: string;
}): ExpensePatchIntent {
  const operationId = assertSafeIdentifier(params.operationId, "operationId");
  if (!Number.isSafeInteger(params.expectedRevision) || params.expectedRevision < 0) {
    throw new Error("expectedRevision must be a non-negative safe integer");
  }
  const amountCents = assertAmountCents(params.amountCents);
  if (typeof params.notes !== "string" || params.notes.length > 1000) {
    throw new Error("Invalid notes");
  }
  return {
    profile: CONTROL_PROFILE,
    kind: "expense.patch",
    operation: {
      dataset_id: FIXTURE_DATASET_ID,
      source_device_id: FIXTURE_DEVICE_ID,
      operation_id: operationId,
    },
    target: {
      travel_id: FIXTURE_TRAVEL_ID,
      branch_id: FIXTURE_BRANCH_ID,
      entity_id: FIXTURE_EXPENSE_ID,
    },
    expected_revision_id: `rev-${params.expectedRevision}`,
    payload: {
      amount_cents: amountCents,
      notes: params.notes,
    },
  };
}

export function buildReceiptLookupIntent(operationId: string): ReceiptLookupIntent {
  return {
    profile: QUERY_PROFILE,
    kind: "receipt.lookup",
    operation: {
      dataset_id: FIXTURE_DATASET_ID,
      source_device_id: FIXTURE_DEVICE_ID,
      operation_id: assertSafeIdentifier(operationId, "operationId"),
    },
  };
}

function canonicalizeValue(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) throw new Error("canonical_integer");
    return String(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalizeValue(item)).join(",")}]`;
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalizeValue(record[key])}`).join(",")}}`;
  }
  throw new Error("Unsupported canonical value");
}

export function canonicalizeControlDocument(intent: ExpensePatchIntent | ExpenseCreateIntent): string {
  return canonicalizeValue({
    canonical_profile: CANONICAL_PROFILE,
    channel: "control",
    intent,
  });
}

export function validateExpenseCreateAmount(raw: unknown): { ok: true; value: number } | { ok: false; error: "type" | "integer_range" } {
  if (typeof raw !== "number") {
    return { ok: false, error: "type" };
  }
  if (!Number.isSafeInteger(raw) || raw < MIN_AMOUNT_CENTS || raw > MAX_AMOUNT_CENTS) {
    return { ok: false, error: "integer_range" };
  }
  return { ok: true, value: raw };
}

export function canonicalizeQueryDocument(intent: ReceiptLookupIntent): string {
  return canonicalizeValue({
    canonical_profile: CANONICAL_PROFILE,
    channel: "receipt-query",
    intent,
  });
}

const DISALLOWED_TITLE_CONTROL_RE = /[\u0000-\u001F\u007F-\u009F]/;
const DISALLOWED_NOTES_CONTROL_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/;

export function parseDecimalYuanToCents(raw: string): number {
  if (typeof raw !== "string" || !/^\d+(?:\.\d{1,2})?$/.test(raw)) {
    throw new Error("金额须为正数且最多两位小数（例如 86.35）");
  }
  const [whole, frac = ""] = raw.split(".");
  const centsBig = BigInt(whole) * 100n + BigInt(frac.padEnd(2, "0"));
  if (centsBig < BigInt(MIN_AMOUNT_CENTS) || centsBig > BigInt(MAX_AMOUNT_CENTS)) {
    throw new Error("金额超出允许范围（0.01 至 99999999.99 元）");
  }
  return Number(centsBig);
}

export function formatCentsToYuan(cents: number): string {
  if (!Number.isSafeInteger(cents) || cents < 0) {
    throw new Error(`Invalid cents value: ${String(cents)}`);
  }
  const whole = Math.floor(cents / 100);
  const frac = String(cents % 100).padStart(2, "0");
  return `${whole}.${frac}`;
}

export function validateExpenseTitle(raw: string): string {
  if (typeof raw !== "string") {
    throw new Error("标题不能为空");
  }
  const trimmed = raw.trim();
  if (trimmed.length === 0 || trimmed.length > 100) {
    throw new Error("标题须为 1 至 100 个非空白字符");
  }
  if (DISALLOWED_TITLE_CONTROL_RE.test(trimmed)) {
    throw new Error("标题不能包含控制字符");
  }
  return trimmed;
}

export function validateExpenseNotes(raw: string): string {
  if (typeof raw !== "string") {
    throw new Error("备注须为文本");
  }
  if (raw.length > 1000) {
    throw new Error("备注长度不能超过 1000 个字符");
  }
  if (DISALLOWED_NOTES_CONTROL_RE.test(raw)) {
    throw new Error("备注包含不允许的控制字符");
  }
  return raw;
}

export function buildOfflineExpenseCreateIntent(params: {
  datasetId: string;
  sourceDeviceId: string;
  operationId: string;
  travelId: string;
  branchId: string;
  entityId: string;
  expectedRevisionId: string;
  title: string;
  amountCents: number;
  category: string;
  notes?: string;
}): ExpenseCreateIntent {
  const datasetId = assertSafeIdentifier(params.datasetId, "datasetId");
  const sourceDeviceId = assertSafeIdentifier(params.sourceDeviceId, "sourceDeviceId");
  const operationId = assertSafeIdentifier(params.operationId, "operationId");
  const travelId = assertSafeIdentifier(params.travelId, "travelId");
  const branchId = assertSafeIdentifier(params.branchId, "branchId");
  const entityId = assertSafeIdentifier(params.entityId, "entityId");
  const expectedRevisionId = assertSafeIdentifier(params.expectedRevisionId, "expectedRevisionId");
  if (operationId === entityId) {
    throw new Error("operation_id and entity_id must be distinct");
  }
  const title = validateExpenseTitle(params.title);
  const amountCents = assertAmountCents(params.amountCents);
  if (!(EXPENSE_CATEGORIES as readonly string[]).includes(params.category)) {
    throw new Error(`Invalid expense category: ${String(params.category)}`);
  }
  const notes = validateExpenseNotes(params.notes ?? "");
  return {
    profile: CONTROL_PROFILE,
    kind: "expense.create",
    operation: {
      dataset_id: datasetId,
      source_device_id: sourceDeviceId,
      operation_id: operationId,
    },
    target: {
      travel_id: travelId,
      branch_id: branchId,
      entity_id: entityId,
    },
    expected_revision_id: expectedRevisionId,
    payload: {
      title,
      amount_cents: amountCents,
      currency: "CNY",
      paid_on: null,
      category: params.category,
      day: null,
      activity_id: null,
      notes,
      receipt_ids: [],
      allow_shared_receipts: false,
      budget_item_id: null,
      settles_budget: false,
    },
  };
}

export function buildOfflineReceiptLookupIntent(params: {
  datasetId: string;
  sourceDeviceId: string;
  operationId: string;
}): ReceiptLookupIntent {
  return {
    profile: QUERY_PROFILE,
    kind: "receipt.lookup",
    operation: {
      dataset_id: assertSafeIdentifier(params.datasetId, "datasetId"),
      source_device_id: assertSafeIdentifier(params.sourceDeviceId, "sourceDeviceId"),
      operation_id: assertSafeIdentifier(params.operationId, "operationId"),
    },
  };
}
