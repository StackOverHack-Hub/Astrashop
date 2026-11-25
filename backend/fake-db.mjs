// In-memory stand-in for DynamoDB that understands only the expressions app.mjs uses.
// Shared by the tests and the local server (local.mjs).
// It also models three real behaviours: reads without ConsistentRead miss fresh writes,
// scans come back in pages of `pageSize`, and `db.failNext` cancels the next transaction.
export function fakeDb(items, { pageSize = Infinity } = {}) {
  const tables = { items: new Map(items.map((i) => [i.id, { ...i }])), reservations: new Map() };
  const holds = (row, expr, names = {}, values = {}) => {
    if (!expr) return true;
    if (expr === 'attribute_not_exists(id)') return !row;
    if (expr === 'attribute_exists(id)') return !!row;
    const [lhs, op, rhs] = expr.split(' ');
    const a = row?.[names[lhs] ?? lhs];
    return a !== undefined && (op === '>=' ? a >= values[rhs] : a === values[rhs]);
  };
  const keyOf = (op) => (op.Item ?? op.Key).id;
  const check = (op) =>
    holds(tables[op.TableName].get(keyOf(op)), op.ConditionExpression, op.ExpressionAttributeNames, op.ExpressionAttributeValues);
  const apply = (op) => {
    const table = tables[op.TableName];
    if (op.Item) return table.set(op.Item.id, { ...op.Item });
    const row = table.get(op.Key.id) ?? { id: op.Key.id };
    const names = op.ExpressionAttributeNames ?? {};
    const values = op.ExpressionAttributeValues;
    for (const part of op.UpdateExpression.replace(/^SET /, '').split(', ')) {
      const [lhs, rhs] = part.split(' = ');
      const [x, sign, y] = rhs.split(' ');
      row[names[lhs] ?? lhs] = sign ? row[names[x] ?? x] + (sign === '+' ? 1 : -1) * values[y] : values[x];
    }
    table.set(row.id, row);
  };
  const fail = (name, extra) => Object.assign(new Error(name), { name, ...extra });

  const db = {
    tables,
    failNext: null,
    async send(cmd) {
      const i = cmd.input;
      switch (cmd.constructor.name) {
        case 'ScanCommand': {
          const rows = [...tables[i.TableName].values()];
          const start = i.ExclusiveStartKey ? rows.findIndex((r) => r.id === i.ExclusiveStartKey.id) + 1 : 0;
          const page = rows.slice(start, start + pageSize);
          const more = start + pageSize < rows.length;
          return {
            Items: page.filter((row) => holds(row, i.FilterExpression, i.ExpressionAttributeNames, i.ExpressionAttributeValues))
              .map((r) => ({ ...r })),
            LastEvaluatedKey: more ? { id: page.at(-1).id } : undefined,
          };
        }
        case 'GetCommand': {
          const row = i.ConsistentRead ? tables[i.TableName].get(i.Key.id) : undefined;
          return { Item: row && { ...row } };
        }
        case 'UpdateCommand':
          if (!check(i)) {
            const row = tables[i.TableName].get(i.Key.id);
            throw fail('ConditionalCheckFailedException', i.ReturnValuesOnConditionCheckFailure && row ? { Item: row } : {});
          }
          apply(i);
          return {};
        case 'TransactWriteCommand': {
          const ops = i.TransactItems.map((t) => t.Update ?? t.Put);
          const injected = db.failNext;
          db.failNext = null;
          const reasons = ops.map((op, n) =>
            ({ Code: injected && n === 0 ? injected : check(op) ? 'None' : 'ConditionalCheckFailed' }));
          if (reasons.some((r) => r.Code !== 'None')) throw fail('TransactionCanceledException', { CancellationReasons: reasons });
          ops.forEach(apply);
          return {};
        }
        default:
          throw new Error(`fake db: unhandled ${cmd.constructor.name}`);
      }
    },
  };
  return db;
}
