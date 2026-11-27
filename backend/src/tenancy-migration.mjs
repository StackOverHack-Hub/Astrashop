import { PutCommand, ScanCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';

// Moves the single-shop pilot data into the many-shop layout. Safe to run any number of times and
// at any point after the new code is live: it only fills in what is missing, and a row that changes
// while it runs is left for the next run. Until it runs, the pilot shop's catalog and counter queue
// are empty (reserving and stats still work), so run it right after deploying.
export async function migrateToTenancy(db, tables, { shopId, name, pickupWindow = '', ownerId, holdMinutes = 1440, now = new Date() }) {
  const counts = { shop: 0, owner: 0, items: 0, reservations: 0, skipped: 0 };
  const at = now.toISOString();
  const skipChanged = (error) => {
    if (error.name !== 'ConditionalCheckFailedException') throw error;
    counts.skipped += 1;
  };
  try {
    await db.send(new PutCommand({
      TableName: tables.tenancy, ConditionExpression: 'attribute_not_exists(sk)',
      Item: { pk: 'SHOP', sk: shopId, name, pickupWindow, status: 'active', plan: 'pilot', createdAt: at, createdBy: 'migration' },
    }));
    counts.shop = 1;
  } catch (error) { if (error.name !== 'ConditionalCheckFailedException') throw error; }
  if (ownerId) {
    for (const Key of [{ pk: `SHOP#${shopId}`, sk: `STAFF#${ownerId}` }, { pk: `USER#${ownerId}`, sk: `SHOP#${shopId}` }]) {
      await db.send(new PutCommand({ TableName: tables.tenancy, Item: { ...Key, role: 'owner', addedBy: 'migration', addedAt: at } }));
    }
    counts.owner = 1;
  }
  const unstamped = async function* (TableName) {
    let ExclusiveStartKey;
    do {
      const page = await db.send(new ScanCommand({ TableName, ExclusiveStartKey, FilterExpression: 'attribute_not_exists(shopId)' }));
      yield* page.Items ?? [];
      ExclusiveStartKey = page.LastEvaluatedKey;
    } while (ExclusiveStartKey);
  };
  for await (const item of unstamped(tables.items)) {
    try {
      await db.send(new UpdateCommand({
        TableName: tables.items, Key: { id: item.id },
        UpdateExpression: 'SET shopId = :shop, version = if_not_exists(version, :zero)',
        ConditionExpression: 'attribute_not_exists(shopId)',
        ExpressionAttributeValues: { ':shop': shopId, ':zero': 0 },
      }));
      counts.items += 1;
    } catch (error) { skipChanged(error); }
  }
  for await (const r of unstamped(tables.reservations)) {
    // Holds made before expiry existed get the same window from createdAt that the old sweep gave them.
    const deadline = new Date(Date.parse(r.createdAt) + holdMinutes * 60_000).toISOString();
    const queued = r.status === 'HELD' || (r.status === 'EXPIRED' && !r.returnedAt);
    try {
      await db.send(new UpdateCommand({
        TableName: tables.reservations, Key: { id: r.id },
        UpdateExpression: `SET shopId = :shop, expiresAt = if_not_exists(expiresAt, :deadline)${queued ? ', queueShop = :shop' : ''}`,
        ConditionExpression: 'attribute_not_exists(shopId) AND #s = :seen',
        ExpressionAttributeNames: { '#s': 'status' },
        ExpressionAttributeValues: { ':shop': shopId, ':deadline': deadline, ':seen': r.status },
      }));
      counts.reservations += 1;
    } catch (error) { skipChanged(error); }
  }
  return counts;
}
