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

export interface PlanInput {
  items: { price: number }[];
  downPayment: number;
  months: number;
  firstDueDate: string;
  /** Sirf wo payments jo wapas nahi hui, purani pehle */
  payments: {
    amount: number;
    paidOn: Date;
    method: string;
    note: string | null;
  }[];
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

export const monthlyOf = (c: PlanInput) =>
  Math.ceil((totalOf(c) - c.downPayment) / c.months);

/** Aakhri qist kam az kam 1 rupay ki honi chahiye */
export function isValidPlan(
  total: number,
  down: number,
  months: number,
): boolean {
  const remaining = total - down;
  if (remaining < 0) return false;
  if (remaining === 0) return true;
  const monthly = Math.ceil(remaining / months);
  return remaining - monthly * (months - 1) >= 1;
}

export function buildSchedule(c: PlanInput, today: string): InstallmentRow[] {
  const remaining = totalOf(c) - c.downPayment;
  const monthly = monthlyOf(c);

  const rows: InstallmentRow[] = Array.from({ length: c.months }, (_, i) => ({
    no: i + 1,
    dueDate: addMonths(c.firstDueDate, i),
    expected:
      i === c.months - 1 ? remaining - monthly * (c.months - 1) : monthly,
    paid: 0,
    status: 'pending',
    daysLate: 0,
  }));

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
