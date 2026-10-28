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
      const daysLate =
        paid < expected
          ? Math.max(...rows.map((row) => row.daysLate))
          : 0;
      const latestPayment = rows
        .filter((row) => row.paidOn)
        .sort((a, b) => (a.paidOn ?? '').localeCompare(b.paidOn ?? ''))
        .at(-1);

      return {
        no: index + 1,
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
  items: { price: number }[];
  downPayment: number;
  initialMonthlyPayment: number;
  firstDueDate: string;
  rateChanges: { fromInstallmentNo: number; monthlyPayment: number }[];
  /** Sirf wo payments jo wapas nahi hui, purani pehle */
  payments: {
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
  rateChanges: { fromInstallmentNo: number; monthlyPayment: number }[];
  createdAt: Date;
}

export interface MultiPlanPayment {
  amount: number;
  paidOn: Date;
  createdAt: Date;
  method: string;
  note: string | null;
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
  const remaining = totalOf(c) - c.downPayment;
  const rateChanges = c.rateChanges;
  const rows: InstallmentRow[] = [];
  let scheduled = 0;
  let installmentNo = 1;
  let changeIndex = 0;
  let activeMonthly = monthlyOf(c);

  while (scheduled < remaining && installmentNo <= MAX_SCHEDULE_INSTALLMENTS) {
    while (
      changeIndex < rateChanges.length &&
      rateChanges[changeIndex].fromInstallmentNo <= installmentNo
    ) {
      activeMonthly = rateChanges[changeIndex].monthlyPayment;
      changeIndex += 1;
    }
    if (activeMonthly <= 0) break;

    const expected = Math.min(activeMonthly, remaining - scheduled);
    rows.push({
      no: installmentNo,
      dueDate: addMonths(c.firstDueDate, installmentNo - 1),
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
      rows[idx].paidOn = dateOnly(p.paidOn);
      rows[idx].method = p.method;
      if (p.note) rows[idx].note = p.note;
      amt -= use;
      if (rows[idx].paid >= rows[idx].expected) idx++;
    }
  }

  for (const r of rows) {
    const late = r.dueDate < today && r.paid < r.expected;
    r.daysLate = late ? diffDays(r.dueDate, today) : 0;
    r.status =
      r.paid >= r.expected
        ? 'paid'
        : r.paid > 0
          ? 'partial'
          : late
            ? 'overdue'
            : 'pending';
  }
  return rows;
}

export function buildMultiPlanSchedules(
  plans: MultiPlanInput[],
  payments: MultiPlanPayment[],
  fallbackDueDate: string,
  today: string,
): InstallmentRow[][] {
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
      row.paidOn = dateOnly(payment.paidOn);
      row.method = payment.method;
      if (payment.note) row.note = payment.note;
      remaining -= amount;
      if (row.paid >= row.expected) cursors[nextPlanIndex] += 1;
    }
  }

  for (const rows of schedules) {
    for (const row of rows) {
      const late = row.dueDate < today && row.paid < row.expected;
      row.daysLate = late ? diffDays(row.dueDate, today) : 0;
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

  return schedules;
}
