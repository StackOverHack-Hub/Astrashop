// The sample catalog used by the seed script and the local server.
// Every item is marked sample: true so demos show it is not a real shop's stock.
export const sampleItems = (now = new Date()) => [
  ['A2 drawing sheet', 'Engineering Drawing', 15, 40],
  ['Mini drafter', 'Engineering Drawing', 450, 3],
  ['French curves set', 'Engineering Drawing', 60, 5],
  ['Lab record book (physics)', 'Physics Lab', 90, 12],
  ['Lab record book (chemistry)', 'Chemistry Lab', 90, 2],
  ['Journal sheets, pack of 20', 'All labs', 40, 25],
  ['Graph paper pad', 'All labs', 50, 8],
  ['Scientific calculator fx-991ES', 'Maths', 1200, 1],
  ['Lab coat, size M', 'Chemistry Lab', 350, 4],
  ['Safety goggles', 'Chemistry Lab', 120, 6],
  ['Breadboard 840 points', 'Electronics Lab', 150, 3],
  ['Jumper wire set', 'Electronics Lab', 80, 0],
].map(([name, course, price, stock], i) => ({
  id: `item-${String(i + 1).padStart(2, '0')}`,
  name, course, price, stock,
  confirmedAt: now.toISOString(),
  pickupWindow: 'Mon–Sat, 10 am–6 pm',
  sample: true,
}));
