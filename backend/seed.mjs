// Usage: node seed.mjs <ItemsTableName>   (uses your AWS CLI credentials and region)
// Every item is marked sample: true so the demo shows it is not a real shop's stock.
// Items that already exist are skipped, so re-running never resets live stock or holds.
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb';

const table = process.argv[2];
if (!table) {
  console.error('Usage: node seed.mjs <ItemsTableName>');
  process.exit(1);
}

const now = new Date().toISOString();
const items = [
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
  confirmedAt: now,
  pickupWindow: 'Mon-Sat, 10 am - 6 pm',
  sample: true,
}));

const db = DynamoDBDocumentClient.from(new DynamoDBClient({}));
let added = 0;
for (const Item of items) {
  try {
    await db.send(new PutCommand({ TableName: table, Item, ConditionExpression: 'attribute_not_exists(id)' }));
    added += 1;
  } catch (err) {
    if (err.name !== 'ConditionalCheckFailedException') throw err;
  }
}
console.log(`Added ${added} sample items to ${table}, skipped ${items.length - added} that already exist`);
