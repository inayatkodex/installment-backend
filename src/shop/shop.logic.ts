import { dateOnly } from '../admin/admin.utils';

export type InstallmentStatus = 'paid' | 'pending' | 'overdue' | 'partial';

export interface InstallmentRow {
  no: number;
  dueDate: string;
  expected: number;
  paid: number;
  status: InstallmentStatus;
  daysLate: number;
  paidOn?: string;
  method?: string;
  note?: string;
}

export function combineInstallmentSchedules(
  schedules: InstallmentRow[][],
): InstallmentRow[] {
  const rowsByDate = new Map<string, InstallmentRow[]>();
  for (const schedule of schedules) {
    for (const row of schedule) {
      const rows = rowsByDate.get(row.dueDate) ?? [];
      rows.push(row);
      rowsByDate.set(row.dueDate, rows);
    }
  }

  return [...rowsByDate.entries()]
    .sort(([dateA], [dateB]) => dateA.localeCompare(dateB))
    .map(([dueDate, rows], index) => {
      const expected = rows.reduce((sum, row) => sum + row.expected, 0);
      const paid = rows.reduce((sum, row) => sum + row.paid, 0);
      const daysLate = Math.max(...rows.map((row) => row.daysLate));
      const latestPayment = rows
        .filter((row) => row.paidOn)
        .sort((a, b) => (a.paidOn ?? '').localeCompare(b.paidOn ?? ''))
        .at(-1);

      return {
        no: rows.length === 1 ? rows[0].no : index + 1,
        dueDate,
        expected,
        paid,
        status:
          paid >= expected
            ? 'paid'
            : paid > 0
              ? 'partial'
              : daysLate > 0
                ? 'overdue'
                : 'pending',
        daysLate,
        paidOn: latestPayment?.paidOn,
        method: latestPayment?.method,
        note: latestPayment?.note,
      };
    });
}

export interface PlanInput {
  planKey?: string;
  items: { price: number }[];
  downPayment: number;
  initialMonthlyPayment: number;
  firstDueDate: string;
  scheduleDateChanges?: {
    fromInstallmentNo: number;
    firstDueDate: string;
  }[];
  rateChanges: { fromInstallmentNo: number; monthlyPayment: number }[];
  /** Sirf wo payments jo wapas nahi hui, purani pehle */
  payments: {
    id?: string;
    amount: number;
    paidOn: Date;
    method: string;
    note: string | null;
  }[];
}

export interface MultiPlanInput {
  id: string;
  items: {
    name: string;
    price: number;
    boughtOn: string;
    photo?: string | null;
  }[];
  downPayment: number;
  initialMonthlyPayment: number;
  firstDueDate: string | null;
  scheduleStartDate?: string;
  scheduleDateChanges?: {
    fromInstallmentNo: number;
    firstDueDate: string;
  }[];
  rateChanges: { fromInstallmentNo: number; monthlyPayment: number }[];
  createdAt: Date;
}

export interface MultiPlanPayment {
  id?: string;
  amount: number;
  paidOn: Date;
  createdAt: Date;
  method: string;
  note: string | null;
}

export interface InstallmentAllocation {
  paymentId: string;
  planKey: string;
  installmentNo: number;
  dueDate: string;
  amount: number;
}

export interface MultiPlanScheduleResult {
  schedules: InstallmentRow[][];
  allocations: InstallmentAllocation[];
}

export interface CashRangeSummary {
  total: number;
  forPeriod: number;
  late: number;
  advance: number;
  lateByMonth: { month: string; amount: number }[];
}

const TZ = 'Asia/Karachi';

export const todayIso = () => dateOnly(new Date());

/** Aaj ki Pakistan time ke hisaab se din ki shuruaat */
export const startOfToday = () => new Date(`${todayIso()}T00:00:00+05:00`);

export function timeLabel(date: Date): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: TZ,
    hour: '2-digit',
    minute: '2-digit',
  })
    .format(date)
    .replace(/\u202f/g, ' ')
    .toLowerCase();
}

export function isRealDate(iso: string): boolean {
  const d = new Date(`${iso}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === iso;
}

export function addMonths(iso: string, n: number): string {
  const [y, m, d] = iso.split('-').map(Number);
  const target = new Date(Date.UTC(y, m - 1 + n, 1));
  const lastDay = new Date(
    Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0),
  ).getUTCDate();
  target.setUTCDate(Math.min(d, lastDay));
  return target.toISOString().slice(0, 10);
}

export function diffDays(a: string, b: string): number {
  return Math.round((Date.parse(b) - Date.parse(a)) / 86400000);
}

export const customerCode = (no: number) => `C-${String(no).padStart(4, '0')}`;

export const totalOf = (c: Pick<PlanInput, 'items'>) =>
  c.items.reduce((s, i) => s + i.price, 0);

export const paidTotalOf = (c: PlanInput) =>
  c.downPayment + c.payments.reduce((s, p) => s + p.amount, 0);

export const monthlyOf = (c: PlanInput) => c.initialMonthlyPayment;

export function activeMonthlyTotal(
  plans: { remaining: number; monthly: number }[],
  target?: number | null,
): number {
  const activeTotal = plans
    .filter((plan) => plan.remaining > 0)
    .reduce((sum, plan) => sum + plan.monthly, 0);
  return target == null ? activeTotal : Math.min(target, activeTotal);
}

export const MAX_SCHEDULE_INSTALLMENTS = 1200;

export function isValidPlan(
  total: number,
  down: number,
  monthlyPayment: number,
): boolean {
  const remaining = total - down;
  if (remaining < 0 || !Number.isSafeInteger(monthlyPayment)) return false;
  if (remaining === 0) return monthlyPayment >= 0;
  if (monthlyPayment <= 0) return false;
  return Math.ceil(remaining / monthlyPayment) <= MAX_SCHEDULE_INSTALLMENTS;
}

export function buildSchedule(c: PlanInput, today: string): InstallmentRow[] {
  return buildScheduleWithAllocations(c, today).rows;
}

export function buildScheduleWithAllocations(
  c: PlanInput,
  today: string,
): { rows: InstallmentRow[]; allocations: InstallmentAllocation[] } {
  const remaining = totalOf(c) - c.downPayment;
  const rateChanges = c.rateChanges;
  const rows: InstallmentRow[] = [];
  const allocations: InstallmentAllocation[] = [];
  let scheduled = 0;
  let installmentNo = 1;
  let changeIndex = 0;
  const dateChanges = [...(c.scheduleDateChanges ?? [])].sort(
    (a, b) => a.fromInstallmentNo - b.fromInstallmentNo,
  );
  let dateChangeIndex = 0;
  let dueDateStart = c.firstDueDate;
  let dueDateStartInstallmentNo = 1;
  let activeMonthly = monthlyOf(c);

  while (scheduled < remaining && installmentNo <= MAX_SCHEDULE_INSTALLMENTS) {
    while (
      changeIndex < rateChanges.length &&
      rateChanges[changeIndex].fromInstallmentNo <= installmentNo
    ) {
      activeMonthly = rateChanges[changeIndex].monthlyPayment;
      changeIndex += 1;
    }
    while (
      dateChangeIndex < dateChanges.length &&
      dateChanges[dateChangeIndex].fromInstallmentNo <= installmentNo
    ) {
      dueDateStart = dateChanges[dateChangeIndex].firstDueDate;
      dueDateStartInstallmentNo =
        dateChanges[dateChangeIndex].fromInstallmentNo;
      dateChangeIndex += 1;
    }
    if (activeMonthly <= 0) break;

    const expected = Math.min(activeMonthly, remaining - scheduled);
    rows.push({
      no: installmentNo,
      dueDate: addMonths(
        dueDateStart,
        installmentNo - dueDateStartInstallmentNo,
      ),
      expected,
      paid: 0,
      status: 'pending',
      daysLate: 0,
    });
    scheduled += expected;
    installmentNo += 1;
  }

  // Har payment sab se purani adhoori qist mein lagti hai
  let idx = 0;
  for (const p of c.payments) {
    let amt = p.amount;
    while (amt > 0 && idx < rows.length) {
      const use = Math.min(rows[idx].expected - rows[idx].paid, amt);
      rows[idx].paid += use;
      if (p.id) {
        allocations.push({
          paymentId: p.id,
          planKey: c.planKey ?? 'base',
          installmentNo: rows[idx].no,
          dueDate: rows[idx].dueDate,
          amount: use,
        });
      }
      rows[idx].paidOn = dateOnly(p.paidOn);
      rows[idx].method = p.method;
      if (p.note) rows[idx].note = p.note;
      amt -= use;
      if (rows[idx].paid >= rows[idx].expected) idx++;
    }
  }

  for (const r of rows) {
    const referenceDate = r.paid >= r.expected ? r.paidOn : today;
    r.daysLate =
      referenceDate && referenceDate > r.dueDate
        ? diffDays(r.dueDate, referenceDate)
        : 0;
    const late = r.daysLate > 0 && r.paid < r.expected;
    r.status =
      r.paid >= r.expected
        ? 'paid'
        : r.paid > 0
          ? 'partial'
          : late
            ? 'overdue'
            : 'pending';
  }
  return { rows, allocations };
}

export function buildMultiPlanSchedules(
  plans: MultiPlanInput[],
  payments: MultiPlanPayment[],
  fallbackDueDate: string,
  today: string,
): InstallmentRow[][] {
  return buildMultiPlanSchedulesWithAllocations(
    plans,
    payments,
    fallbackDueDate,
    today,
  ).schedules;
}

export function buildMultiPlanSchedulesWithAllocations(
  plans: MultiPlanInput[],
  payments: MultiPlanPayment[],
  fallbackDueDate: string,
  today: string,
): MultiPlanScheduleResult {
  const schedules = plans.map((plan) =>
    buildSchedule(
      {
        ...plan,
        firstDueDate:
          plan.firstDueDate ?? plan.scheduleStartDate ?? fallbackDueDate,
        payments: [],
      },
      today,
    ),
  );
  const allocations: InstallmentAllocation[] = [];
  const cursors = plans.map(() => 0);
  const orderedPayments = [...payments].sort(
    (a, b) =>
      a.paidOn.getTime() - b.paidOn.getTime() ||
      a.createdAt.getTime() - b.createdAt.getTime(),
  );

  for (const payment of orderedPayments) {
    let remaining = payment.amount;
    while (remaining > 0) {
      let nextPlanIndex = -1;
      let nextDueDate = '';
      for (let planIndex = 0; planIndex < plans.length; planIndex += 1) {
        if (plans[planIndex].createdAt > payment.createdAt) continue;
        const row = schedules[planIndex][cursors[planIndex]];
        if (!row) continue;
        if (nextPlanIndex < 0 || row.dueDate < nextDueDate) {
          nextPlanIndex = planIndex;
          nextDueDate = row.dueDate;
        }
      }

      if (nextPlanIndex < 0) break;
      const row = schedules[nextPlanIndex][cursors[nextPlanIndex]];
      const amount = Math.min(row.expected - row.paid, remaining);
      row.paid += amount;
      if (payment.id) {
        allocations.push({
          paymentId: payment.id,
          planKey: plans[nextPlanIndex].id,
          installmentNo: row.no,
          dueDate: row.dueDate,
          amount,
        });
      }
      row.paidOn = dateOnly(payment.paidOn);
      row.method = payment.method;
      if (payment.note) row.note = payment.note;
      remaining -= amount;
      if (row.paid >= row.expected) cursors[nextPlanIndex] += 1;
    }
  }

  for (const rows of schedules) {
    for (const row of rows) {
      const referenceDate = row.paid >= row.expected ? row.paidOn : today;
      row.daysLate =
        referenceDate && referenceDate > row.dueDate
          ? diffDays(row.dueDate, referenceDate)
          : 0;
      const late = row.daysLate > 0 && row.paid < row.expected;
      row.status =
        row.paid >= row.expected
          ? 'paid'
          : row.paid > 0
            ? 'partial'
            : late
              ? 'overdue'
              : 'pending';
    }
  }

  return { schedules, allocations };
}

export function summarizeCashInRange(
  payments: { id: string; amount: number; reversedAt?: Date | null }[],
  allocations: InstallmentAllocation[],
  fromIso: string,
  toIso: string,
): CashRangeSummary {
  const activePayments = payments.filter((payment) => !payment.reversedAt);
  const total = activePayments.reduce((sum, payment) => sum + payment.amount, 0);
  const activePaymentIds = new Set(activePayments.map((payment) => payment.id));
  const amountsByPayment = new Map<string, number>();
  const breakdown: CashRangeSummary = {
    total,
    forPeriod: 0,
    late: 0,
    advance: 0,
    lateByMonth: [],
  };
  const lateByMonth = new Map<string, number>();

  for (const allocation of allocations) {
    if (!activePaymentIds.has(allocation.paymentId)) continue;
    amountsByPayment.set(
      allocation.paymentId,
      (amountsByPayment.get(allocation.paymentId) ?? 0) + allocation.amount,
    );
    if (allocation.dueDate < fromIso) {
      breakdown.late += allocation.amount;
      const month = allocation.dueDate.slice(0, 7);
      lateByMonth.set(
        month,
        (lateByMonth.get(month) ?? 0) + allocation.amount,
      );
    }
    else if (allocation.dueDate > toIso) breakdown.advance += allocation.amount;
    else breakdown.forPeriod += allocation.amount;
  }

  for (const payment of activePayments) {
    if ((amountsByPayment.get(payment.id) ?? 0) !== payment.amount) {
      throw new Error(`Payment ${payment.id} is not fully allocated`);
    }
  }
  if (breakdown.forPeriod + breakdown.late + breakdown.advance !== total) {
    throw new Error('Cash allocation breakdown does not match the payment total');
  }
  breakdown.lateByMonth = [...lateByMonth.entries()]
    .map(([month, amount]) => ({ month, amount }))
    .sort((left, right) => left.month.localeCompare(right.month));

  return breakdown;
}
