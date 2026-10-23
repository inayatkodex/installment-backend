const TZ = 'Asia/Karachi';

function karachiParts(date: Date) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  return { year: get('year'), month: get('month'), day: get('day') };
}

/** "YYYY-MM-DD" (Pakistan time) */
export function dateOnly(date: Date): string {
  const { year, month, day } = karachiParts(date);
  return `${year}-${month}-${day}`;
}

/** "YYYY-MM" (Pakistan time) */
export function currentMonth(): string {
  const { year, month } = karachiParts(new Date());
  return `${year}-${month}`;
}

/** "2026-10" -> "October 2026" */
export function monthLabel(month: string): string {
  return new Date(`${month}-01T00:00:00Z`).toLocaleString('en-US', {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

/** "03001234567" -> "0300-1234567" */
export function formatMobile(mobile: string): string {
  return /^03\d{9}$/.test(mobile) ? `${mobile.slice(0, 4)}-${mobile.slice(4)}` : mobile;
}

export function shopCode(shopNo: number): string {
  return `SH-${100 + shopNo}`;
}