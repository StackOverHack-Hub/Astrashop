import { setTimeout as delay } from 'node:timers/promises';
import { BatchGetCommand, GetCommand, QueryCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';

const keyOf = (pk, sk) => JSON.stringify([pk, sk]);

export function dynamoMarketplace(db, table) {
  return {
    async get(pk, sk) {
      return (await db.send(new GetCommand({
        TableName: table, Key: { pk, sk }, ConsistentRead: true,
      }))).Item;
    },
    async getMany(keys) {
      const unique = new Map(keys.map(([pk, sk]) => [keyOf(pk, sk), { pk, sk }]));
      const items = new Map();
      let pending = [...unique.values()];
      for (let attempt = 0; pending.length && attempt < 4; attempt++) {
        if (attempt) await delay(20 * 2 ** attempt);
        const result = await db.send(new BatchGetCommand({
          RequestItems: { [table]: { Keys: pending, ConsistentRead: true } },
        }));
        for (const item of result.Responses?.[table] ?? []) items.set(keyOf(item.pk, item.sk), item);
        pending = result.UnprocessedKeys?.[table]?.Keys ?? [];
      }
      if (pending.length) throw Object.assign(new Error('Batch read throttled'), { name: 'ThrottlingException' });
      return keys.map(([pk, sk]) => items.get(keyOf(pk, sk)));
    },
    async query(pk, { lower, upper, ascending = false, limit }) {
      const names = { '#pk': 'pk' };
      const values = { ':pk': pk };
      let condition = '#pk = :pk';
      if (lower !== undefined || upper !== undefined) {
        names['#sk'] = 'sk';
        if (lower !== undefined) values[':lower'] = lower;
        if (upper !== undefined) values[':upper'] = upper;
        if (lower !== undefined && upper !== undefined) condition += ' AND #sk BETWEEN :lower AND :upper';
        else if (lower !== undefined) condition += ' AND #sk >= :lower';
        else condition += ' AND #sk < :upper';
      }
      const result = await db.send(new QueryCommand({
        TableName: table, KeyConditionExpression: condition, ExpressionAttributeNames: names,
        ExpressionAttributeValues: values, ConsistentRead: true, ScanIndexForward: ascending, Limit: limit,
      }));
      // The application caps record and page sizes below the 1 MB Query boundary.
      return result.Items ?? [];
    },
    async transact(writes) {
      try {
        await db.send(new TransactWriteCommand({
          TransactItems: writes.map(({ kind, row, version }) => {
            const key = { pk: row.pk, sk: row.sk };
            if (kind === 'delete') return { Delete: { TableName: table, Key: key } };
            if (kind === 'rating') return { Update: {
              TableName: table, Key: key, UpdateExpression: 'ADD #count :one, #sum :rating',
              ExpressionAttributeNames: { '#count': 'count', '#sum': 'sum' },
              ExpressionAttributeValues: { ':one': 1, ':rating': row.rating },
            } };
            const condition = version === undefined
              ? { ConditionExpression: 'attribute_not_exists(pk)' }
              : version === 0
                ? { ConditionExpression: 'attribute_exists(pk) AND attribute_not_exists(#version)', ExpressionAttributeNames: { '#version': 'version' } }
              : {
                ConditionExpression: '#version = :version',
                ExpressionAttributeNames: { '#version': 'version' },
                ExpressionAttributeValues: { ':version': version },
              };
            if (kind === 'guardDelete') return { Delete: { TableName: table, Key: key, ...condition } };
            if (kind === 'check') return { ConditionCheck: { TableName: table, Key: key, ...condition } };
            return { Put: { TableName: table, Item: row, ...(kind === 'put' ? {} : condition) } };
          }),
        }));
        return true;
      } catch (error) {
        const codes = error.CancellationReasons?.map(({ Code }) => Code) ?? [];
        if (error.name === 'TransactionCanceledException' &&
          codes.includes('ConditionalCheckFailed') && codes.every((code) => ['None', 'ConditionalCheckFailed'].includes(code))) {
          return false;
        }
        throw error;
      }
    },
  };
}
