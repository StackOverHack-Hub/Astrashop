// Usage: node seed.mjs <ItemsTableName>   (uses your AWS CLI credentials and region)
// Items that already exist are skipped, so re-running never resets live stock or holds.
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb';
import { sampleItems } from './sample-items.mjs';

const table = process.argv[2];
if (!table) {
  console.error('Usage: node seed.mjs <ItemsTableName>');
  process.exit(1);
}

const items = sampleItems();

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
