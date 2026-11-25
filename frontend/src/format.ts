const currency = new Intl.NumberFormat('en-IN', {
  style: 'currency', currency: 'INR', minimumFractionDigits: 0, maximumFractionDigits: 2,
});
const relative = new Intl.RelativeTimeFormat('en', { numeric: 'always' });

export const price = (amount: number) => currency.format(amount);

export function age(timestamp: string) {
  const minutes = Math.floor((Date.now() - Date.parse(timestamp)) / 60_000);
  if (!Number.isFinite(minutes)) return 'at an unknown time';
  if (minutes < 1) return 'just now';
  if (minutes < 60) return relative.format(-minutes, 'minute');
  if (minutes < 1_440) return relative.format(-Math.floor(minutes / 60), 'hour');
  return relative.format(-Math.floor(minutes / 1_440), 'day');
}
