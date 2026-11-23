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
    amount_cents: number;
    notes: string;
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

export function canonicalizeControlDocument(intent: ExpensePatchIntent): string {
  return canonicalizeValue({
    canonical_profile: CANONICAL_PROFILE,
    channel: "control",
    intent,
  });
}

export function canonicalizeQueryDocument(intent: ReceiptLookupIntent): string {
  return canonicalizeValue({
    canonical_profile: CANONICAL_PROFILE,
    channel: "receipt-query",
    intent,
  });
}
