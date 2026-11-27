import { CreateTableCommand, DescribeTableCommand, UpdateTableCommand, waitUntilTableExists } from '@aws-sdk/client-dynamodb';
import { PutCommand } from '@aws-sdk/lib-dynamodb';
import { sampleItems } from '../sample-items.mjs';
import { tableSchemas } from './schema.mjs';
import { setTimeout as delay } from 'node:timers/promises';

const keySchema = (names) => names.map((AttributeName, i) => ({ AttributeName, KeyType: i ? 'RANGE' : 'HASH' }));
const indexDefinition = ([IndexName, names]) => ({ IndexName, KeySchema: keySchema(names), Projection: { ProjectionType: 'ALL' } });
const attributes = (names) => [...new Set(names)].map((AttributeName) => ({ AttributeName, AttributeType: 'S' }));

export async function initializeLocalTables(client, db, tables) {
  // JVM startup can take longer than the Redis readiness check on a cold host.
  // Wait for an actual DynamoDB response before issuing table creation calls.
  for (let attempt = 0; ; attempt++) {
    try { await client.send(new DescribeTableCommand({ TableName: tables.items })); break; }
    catch (error) {
      if (error.name === 'ResourceNotFoundException') break;
      if (attempt === 89) throw error;
      await delay(500);
    }
  }
  for (const [name, TableName] of Object.entries(tables)) {
    const { key, indexes = {} } = tableSchemas[name];
    try {
      await client.send(new CreateTableCommand({
        TableName, BillingMode: 'PAY_PER_REQUEST',
        AttributeDefinitions: attributes([...key, ...Object.values(indexes).flat()]),
        KeySchema: keySchema(key),
        ...(Object.keys(indexes).length ? { GlobalSecondaryIndexes: Object.entries(indexes).map(indexDefinition) } : {}),
      }));
    } catch (error) { if (error.name !== 'ResourceInUseException') throw error; }
    await waitUntilTableExists({ client, maxWaitTime: 30, minDelay: 1, maxDelay: 2 }, { TableName });
    let { Table } = await client.send(new DescribeTableCommand({ TableName }));
    if (JSON.stringify(Table.KeySchema) !== JSON.stringify(keySchema(key))) throw new Error(`Unexpected key schema for ${TableName}`);
    // Tables kept in the Docker volume from an older version get the indexes added in place.
    for (const entry of Object.entries(indexes)) {
      if (Table.GlobalSecondaryIndexes?.some(({ IndexName }) => IndexName === entry[0])) continue;
      await client.send(new UpdateTableCommand({
        TableName, AttributeDefinitions: attributes(entry[1]), GlobalSecondaryIndexUpdates: [{ Create: indexDefinition(entry) }],
      }));
      for (let attempt = 0; ; attempt++) {
        ({ Table } = await client.send(new DescribeTableCommand({ TableName })));
        if (Table.GlobalSecondaryIndexes?.find(({ IndexName }) => IndexName === entry[0])?.IndexStatus === 'ACTIVE') break;
        if (attempt === 120) throw new Error(`Index ${entry[0]} on ${TableName} did not become active`);
        await delay(500);
      }
    }
  }
  for (const Item of sampleItems()) {
    try { await db.send(new PutCommand({ TableName: tables.items, Item, ConditionExpression: 'attribute_not_exists(id)' })); }
    catch (error) { if (error.name !== 'ConditionalCheckFailedException') throw error; }
  }
}

// Gives the demo shop an owner and a staff member, through the same route an owner would use.
export async function seedLocalShop(handler, identities, shopId) {
  for (const [account, role] of [['owner', 'owner'], ['staff', 'staff']]) {
    const result = await handler({
      routeKey: 'PUT /shops/{shopId}/staff/{userId}', headers: {},
      pathParameters: { shopId, userId: identities.get(`Bearer demo-${account}`).sub },
      body: JSON.stringify({ role }),
      requestContext: { authorizer: { jwt: { claims: identities.get('Bearer demo-admin') } } },
    });
    if (result.statusCode !== 200) throw new Error(`Local shop seed failed: ${result.statusCode}`);
  }
}

export async function seedLocalMarketplace(handler, identities) {
  async function seed(routeKey, account, body) {
    const result = await handler({
      routeKey, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
      requestContext: { authorizer: { jwt: { claims: identities.get(`Bearer demo-${account}`) } } },
    });
    if (![200, 201, 409].includes(result.statusCode)) throw new Error(`Local seed failed: ${result.statusCode}`);
  }
  for (const [account, name, programme, about] of [
    ['asha', 'Asha', 'Product Design', 'I share drawing supplies and help students get started in the workshop.'],
    ['ravi', 'Ravi', 'Mechanical Engineering', 'I like fixing bikes and finding a second home for useful things.'],
  ]) await seed('PUT /marketplace/profile', account, { name, programme, about });
  for (const [index, [kind, title, description, meetup, pricePaise]] of [
    ['item', 'Mini drafter', 'Used for one drawing course. Includes the carrying sleeve.', 'Library courtyard', 24000],
    ['service', 'Bicycle tune-up', 'I can adjust your brakes and gears after class.', 'Student activity centre', 15000],
    ['favor', 'Help with first-year lab setup', 'I can show you how to set up the shared equipment.', 'Physics lab lobby', 0],
  ].entries()) {
    await seed('POST /marketplace/listings', index === 1 ? 'ravi' : 'asha', {
      id: `00000000-0000-4000-8000-00000000000${index}`, kind, title, description, meetup, pricePaise,
      condition: kind === 'item' ? 'good' : '', scope: kind === 'item' ? '' : description, availability: 'Weekdays after class',
    });
  }
}
