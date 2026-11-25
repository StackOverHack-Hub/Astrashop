const relative = new Intl.RelativeTimeFormat('en', { numeric: 'always' });

const clockTime = new Intl.DateTimeFormat('en-IN', { weekday: 'short', hour: 'numeric', minute: '2-digit' });

export const until = (timestamp: string) => clockTime.format(new Date(timestamp));

const number = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 2 });
// Price without the currency sign, so the ₹ can be set small next to a large number.
export const amount = (value: number) => number.format(value);

// Pickup codes read and match faster at the counter in two groups of three: 448 835.
export const groupCode = (code: string) => code.replace(/^(\d{3})(\d{3})$/, '$1 $2');

// Pilot durations: "7.5 min", "2 h 5 min", or a plain note when there is nothing to measure yet.
export function duration(minutes: number | null) {
  if (minutes === null) return 'No data yet';
  if (minutes < 60) return `${minutes} min`;
  const rounded = Math.round(minutes);
  const hours = Math.floor(rounded / 60);
  const rest = rounded % 60;
  return rest ? `${hours} h ${rest} min` : `${hours} h`;
}

// Availability in the words a student would use, with a level for the status dot.
export function availability(stock: number): { level: 'in' | 'low' | 'out'; text: string } {
  if (stock <= 0) return { level: 'out', text: 'Sold out' };
  if (stock <= 3) return { level: 'low', text: `Only ${stock} left` };
  return { level: 'in', text: `${stock} on the shelf` };
}

export function age(timestamp: string) {
  const minutes = Math.floor((Date.now() - Date.parse(timestamp)) / 60_000);
  if (!Number.isFinite(minutes)) return 'at an unknown time';
  if (minutes < 1) return 'just now';
  if (minutes < 60) return relative.format(-minutes, 'minute');
  if (minutes < 1_440) return relative.format(-Math.floor(minutes / 60), 'hour');
  return relative.format(-Math.floor(minutes / 1_440), 'day');
}
