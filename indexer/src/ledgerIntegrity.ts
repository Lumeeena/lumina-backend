export interface LedgerCounts {
  transactions: number;
  operations: number;
}

export interface LedgerCountDiscrepancy {
  entity: keyof LedgerCounts;
  expected: number;
  actual: number;
}

export interface LedgerCountRepairResult {
  detected: LedgerCountDiscrepancy[];
  remaining: LedgerCountDiscrepancy[];
  repairSucceeded: boolean;
}

export function findLedgerCountDiscrepancies(
  expected: LedgerCounts,
  actual: LedgerCounts
): LedgerCountDiscrepancy[] {
  return (['transactions', 'operations'] as const)
    .filter(entity => expected[entity] !== actual[entity])
    .map(entity => ({ entity, expected: expected[entity], actual: actual[entity] }));
}

export async function verifyAndRepairLedgerCounts(
  expected: LedgerCounts,
  actual: LedgerCounts,
  repair: () => Promise<boolean>,
  readActual: () => Promise<LedgerCounts>
): Promise<LedgerCountRepairResult> {
  const detected = findLedgerCountDiscrepancies(expected, actual);
  if (detected.length === 0) {
    return { detected, remaining: [], repairSucceeded: true };
  }

  const repairSucceeded = await repair();
  const remaining = findLedgerCountDiscrepancies(expected, await readActual());
  return { detected, remaining, repairSucceeded };
}