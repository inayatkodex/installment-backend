import {
  activeMonthlyTotal,
  buildMultiPlanSchedules,
  buildSchedule,
  combineInstallmentSchedules,
  isValidPlan,
  MultiPlanInput,
  PlanInput,
} from './shop.logic';

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

describe('multiple purchase plan allocation', () => {
  const createdAt = new Date('2026-11-01T00:00:00Z');
  const plans: MultiPlanInput[] = [
    {
      id: 'a',
      items: [{ price: 100000 }],
      downPayment: 25000,
      initialMonthlyPayment: 7500,
      firstDueDate: '2026-11-25',
      rateChanges: [],
      createdAt: new Date('2026-10-01T00:00:00Z'),
    },
    {
      id: 'b',
      items: [{ price: 30000 }],
      downPayment: 0,
      initialMonthlyPayment: 3000,
      firstDueDate: null,
      rateChanges: [],
      createdAt,
    },
  ];

  it('pays Plan A first, then applies the remaining amount to Plan B', () => {
    const schedules = buildMultiPlanSchedules(
      plans,
      [
        {
          amount: 10500,
          paidOn: new Date('2026-11-25T10:00:00Z'),
          createdAt: new Date('2026-11-25T10:00:00Z'),
          method: 'Cash',
          note: null,
        },
      ],
      '2026-11-25',
      '2026-11-25',
    );

    expect(schedules[0][0].paid).toBe(7500);
    expect(schedules[1][0].paid).toBe(3000);
    expect(schedules[0][0].status).toBe('paid');
    expect(schedules[1][0].status).toBe('paid');
  });

  it('shows matching plan qistein as one combined monthly installment', () => {
    const schedules = buildMultiPlanSchedules(
      plans,
      [],
      '2026-11-25',
      '2026-11-25',
    );
    const combined = combineInstallmentSchedules(schedules);

    expect(combined[0]).toMatchObject({
      no: 1,
      dueDate: '2026-11-25',
      expected: 10500,
      paid: 0,
      status: 'pending',
    });
    expect(combined).toHaveLength(schedules[0].length);
  });

  it('shows plans with different due dates as separate installments', () => {
    const datedPlans = plans.map((plan, index) =>
      index === 1 ? { ...plan, firstDueDate: '2026-12-05' } : plan,
    );
    const schedules = buildMultiPlanSchedules(
      datedPlans,
      [],
      '2026-11-25',
      '2026-11-25',
    );
    const combined = combineInstallmentSchedules(schedules);

    expect(combined.slice(0, 2)).toMatchObject([
      { no: 1, dueDate: '2026-11-25', expected: 7500 },
      { no: 1, dueDate: '2026-12-05', expected: 3000 },
    ]);
  });

  it('uses the remaining balance of a partially paid combined installment', () => {
    const schedules = buildMultiPlanSchedules(
      plans,
      [
        {
          amount: 9000,
          paidOn: new Date('2026-11-25T10:00:00Z'),
          createdAt: new Date('2026-11-25T10:00:00Z'),
          method: 'Cash',
          note: null,
        },
      ],
      '2026-11-25',
      '2026-11-25',
    );
    const [next] = combineInstallmentSchedules(schedules);

    expect(next.expected - next.paid).toBe(1500);
  });

  it('reduces monthly total when Plan A is fully paid', () => {
    expect(
      activeMonthlyTotal(
        [
          { remaining: 0, monthly: 7000 },
          { remaining: 25000, monthly: 5000 },
        ],
        12000,
      ),
    ).toBe(5000);
  });

  it('keeps a short payment on Plan A before distributing the remainder', () => {
    const schedules = buildMultiPlanSchedules(
      plans,
      [
        {
          amount: 9000,
          paidOn: new Date('2026-11-25T10:00:00Z'),
          createdAt: new Date('2026-11-25T10:00:00Z'),
          method: 'Cash',
          note: null,
        },
      ],
      '2026-11-25',
      '2026-11-25',
    );

    expect(schedules[0][0].paid).toBe(7500);
    expect(schedules[1][0].paid).toBe(1500);
    expect(schedules[1][0].status).toBe('partial');
  });

  it('uses the full payment for Plan A when it is below Plan A monthly amount', () => {
    const monthlyPlans = plans.map((item, index) => ({
      ...item,
      initialMonthlyPayment: index === 0 ? 6500 : 2500,
    }));
    const schedules = buildMultiPlanSchedules(
      monthlyPlans,
      [
        {
          amount: 4500,
          paidOn: new Date('2026-11-25T10:00:00Z'),
          createdAt: new Date('2026-11-25T10:00:00Z'),
          method: 'Cash',
          note: null,
        },
      ],
      '2026-11-25',
      '2026-11-25',
    );

    expect(schedules[0][0].paid).toBe(4500);
    expect(schedules[1][0].paid).toBe(0);
  });

  it('splits the combined monthly payment after completing Plan A first', () => {
    const monthlyPlans = plans.map((item, index) => ({
      ...item,
      initialMonthlyPayment: index === 0 ? 6500 : 2500,
    }));
    const schedules = buildMultiPlanSchedules(
      monthlyPlans,
      [
        {
          amount: 7500,
          paidOn: new Date('2026-11-25T10:00:00Z'),
          createdAt: new Date('2026-11-25T10:00:00Z'),
          method: 'Cash',
          note: null,
        },
      ],
      '2026-11-25',
      '2026-11-25',
    );

    expect(schedules[0][0].paid).toBe(6500);
    expect(schedules[1][0].paid).toBe(1000);
    expect(schedules[1][0].status).toBe('partial');
    expect(combineInstallmentSchedules(schedules)[0]).toMatchObject({
      expected: 9000,
      paid: 7500,
      status: 'partial',
    });
  });

  it('subtracts Plan B advance from its balance without changing its monthly installment', () => {
    const planB = {
      ...plans[1],
      downPayment: 5000,
      initialMonthlyPayment: 2500,
    };
    const schedules = buildMultiPlanSchedules(
      [planB],
      [],
      '2026-11-25',
      '2026-11-25',
    );

    expect(schedules[0]).toHaveLength(10);
    expect(schedules[0].every((row) => row.expected === 2500)).toBe(true);
    expect(
      planB.downPayment +
        schedules[0].reduce((sum, row) => sum + row.expected, 0),
    ).toBe(30000);
  });

  it('does not allocate earlier payments to a purchase that did not exist yet', () => {
    const schedules = buildMultiPlanSchedules(
      plans,
      [
        {
          amount: 5000,
          paidOn: new Date('2026-10-20T10:00:00Z'),
          createdAt: new Date('2026-10-20T10:00:00Z'),
          method: 'Cash',
          note: null,
        },
      ],
      '2026-11-25',
      '2026-11-25',
    );

    expect(schedules[0][0].paid).toBe(5000);
    expect(schedules[1][0].paid).toBe(0);
  });

  it('starts a new purchase on the base plan’s next unpaid installment date', () => {
    const datedPlans = plans.map((item, index) =>
      index === 1 ? { ...item, scheduleStartDate: '2026-12-25' } : item,
    );
    const schedules = buildMultiPlanSchedules(
      datedPlans,
      [
        {
          amount: 7500,
          paidOn: new Date('2026-11-25T10:00:00Z'),
          createdAt: new Date('2026-11-25T10:00:00Z'),
          method: 'Cash',
          note: null,
        },
        {
          amount: 10500,
          paidOn: new Date('2026-12-25T10:00:00Z'),
          createdAt: new Date('2026-12-25T10:00:00Z'),
          method: 'Cash',
          note: null,
        },
      ],
      '2026-11-25',
      '2026-12-25',
    );

    expect(schedules[0][0].paid).toBe(7500);
    expect(schedules[0][1].paid).toBe(7500);
    expect(schedules[1][0].paid).toBe(3000);
    expect(schedules[0][1].dueDate).toBe(schedules[1][0].dueDate);
  });
});
