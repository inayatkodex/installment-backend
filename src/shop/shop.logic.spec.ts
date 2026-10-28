import { buildSchedule, isValidPlan, PlanInput } from './shop.logic';

const plan = (overrides: Partial<PlanInput> = {}): PlanInput => ({
  items: [{ price: 34400 }],
  downPayment: 4400,
  initialMonthlyPayment: 2000,
  firstDueDate: '2026-11-25',
  rateChanges: [],
  payments: [],
  ...overrides,
});

describe('installment schedule', () => {
  it('creates monthly installments until the balance is paid and adjusts the last amount', () => {
    const rows = buildSchedule(
      plan({ items: [{ price: 34900 }] }),
      '2026-10-28',
    );

    expect(rows).toHaveLength(16);
    expect(rows.slice(0, 15).every((row) => row.expected === 2000)).toBe(true);
    expect(rows[15].expected).toBe(500);
    expect(rows[0].dueDate).toBe('2026-11-25');
    expect(rows[15].dueDate).toBe('2028-02-25');
  });

  it('applies a new monthly amount from its effective installment', () => {
    const rows = buildSchedule(
      plan({
        items: [{ price: 10400 }],
        downPayment: 400,
        rateChanges: [{ fromInstallmentNo: 3, monthlyPayment: 3000 }],
      }),
      '2026-10-28',
    );

    expect(rows.map((row) => row.expected)).toEqual([2000, 2000, 3000, 3000]);
  });

  it('keeps the original and intervening rates when later rates are added', () => {
    const rows = buildSchedule(
      plan({
        items: [{ price: 17400 }],
        downPayment: 400,
        rateChanges: [
          { fromInstallmentNo: 3, monthlyPayment: 3000 },
          { fromInstallmentNo: 5, monthlyPayment: 1000 },
        ],
      }),
      '2026-10-28',
    );

    expect(rows.map((row) => row.expected)).toEqual([
      2000, 2000, 3000, 3000, 1000, 1000, 1000, 1000, 1000, 1000, 1000,
    ]);
  });

  it('keeps a partially paid installment at its old amount', () => {
    const rows = buildSchedule(
      plan({
        items: [{ price: 10400 }],
        downPayment: 400,
        rateChanges: [{ fromInstallmentNo: 2, monthlyPayment: 3000 }],
        payments: [
          {
            amount: 500,
            paidOn: new Date('2026-11-25T10:00:00Z'),
            method: 'Cash',
            note: null,
          },
        ],
      }),
      '2026-10-28',
    );

    expect(rows.map((row) => row.expected)).toEqual([2000, 3000, 3000, 2000]);
    expect(rows[0].paid).toBe(500);
  });

  it('rejects plans that would exceed the schedule limit', () => {
    expect(isValidPlan(5000, 0, 5)).toBe(true);
    expect(isValidPlan(5000, 0, 0)).toBe(false);
    expect(isValidPlan(5000, 0, 4)).toBe(false);
  });
});
