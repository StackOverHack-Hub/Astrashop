// In-memory stand-in for DynamoDB that understands only the expressions app.mjs uses.
// Shared by the tests and the local server (local.mjs).
// It also models three real behaviours: reads without ConsistentRead miss fresh writes,
// scans and queries come back in pages of `pageSize`, and `db.failNext` cancels the next transaction.
import { tableSchemas } from './src/schema.mjs';

const comparisons = {
  '=': (a, b) => a === b, '<>': (a, b) => a !== b, '<': (a, b) => a < b,
  '<=': (a, b) => a <= b, '>': (a, b) => a > b, '>=': (a, b) => a >= b,
};

export function fakeDb(items, { pageSize = Infinity } = {}) {
  const tables = Object.fromEntries(Object.keys(tableSchemas).map((name) => [name, new Map()]));
  // Single-attribute keys stay plain strings so tests can read tables.items.get('item-1').
  const keyOf = (table, row) => {
    const parts = tableSchemas[table].key.map((name) => row[name]);
    return parts.length === 1 ? parts[0] : JSON.stringify(parts);
  };
  for (const item of items) tables.items.set(item.id, { ...item });

  const fail = (name, extra) => Object.assign(new Error(name), { name, ...extra });
  const attr = (row, token, names) => row?.[names[token] ?? token];
  const operand = (row, token, names, values) => token.startsWith(':') ? values[token] : attr(row, token, names);
  const clause = (row, text, names, values) => {
    let match;
    if ((match = text.match(/^attribute_not_exists\(([#\w]+)\)$/))) return attr(row, match[1], names) === undefined;
    if ((match = text.match(/^attribute_exists\(([#\w]+)\)$/))) return attr(row, match[1], names) !== undefined;
    if ((match = text.match(/^begins_with\(([#\w]+), (:\w+)\)$/))) {
      const value = attr(row, match[1], names);
      return typeof value === 'string' && value.startsWith(values[match[2]]);
    }
    const [lhs, op, rhs] = text.split(' ');
    if (!comparisons[op]) throw new Error(`fake db: unsupported condition ${text}`);
    const a = operand(row, lhs, names, values);
    const b = operand(row, rhs, names, values);
    return a !== undefined && b !== undefined && comparisons[op](a, b);
  };
  // AND binds tighter than OR, as in DynamoDB. app.mjs never needs parentheses.
  const holds = (row, expr, names = {}, values = {}) => !expr
    || expr.split(' OR ').some((alt) => alt.split(' AND ').every((part) => clause(row, part.trim(), names, values)));

  const check = (op) => holds(tables[op.TableName].get(keyOf(op.TableName, op.Item ?? op.Key)),
    op.ConditionExpression, op.ExpressionAttributeNames, op.ExpressionAttributeValues);
  const apply = (op) => {
    const table = tables[op.TableName];
    if (op.Item) return table.set(keyOf(op.TableName, op.Item), structuredClone(op.Item));
    const id = keyOf(op.TableName, op.Key);
    if (op.delete) return table.delete(id);
    const row = structuredClone(table.get(id) ?? op.Key);
    const names = op.ExpressionAttributeNames ?? {};
    const values = op.ExpressionAttributeValues ?? {};
    const term = (text) => {
      const keep = text.match(/^if_not_exists\(([#\w]+), (:\w+)\)$/);
      return keep ? attr(row, keep[1], names) ?? values[keep[2]] : operand(row, text, names, values);
    };
    const [, set = '', remove = ''] = op.UpdateExpression.match(/^(?:SET (.+?))?\s*(?:REMOVE (.+))?$/);
    for (const part of set ? set.split(/, (?![^(]*\))/) : []) {
      const [lhs, rhs] = part.split(' = ');
      const math = rhs.match(/^(.+?) ([+-]) (:\w+)$/);
      if (math && typeof term(math[1]) !== 'number') throw fail('ValidationException');
      row[names[lhs] ?? lhs] = math ? term(math[1]) + (math[2] === '+' ? 1 : -1) * values[math[3]] : term(rhs);
    }
    for (const name of remove ? remove.split(', ') : []) delete row[names[name] ?? name];
    table.set(id, row);
  };
  const page = (rows, table, input, extra = []) => {
    const start = input.ExclusiveStartKey
      ? rows.findIndex((row) => keyOf(table, row) === keyOf(table, input.ExclusiveStartKey)) + 1 : 0;
    const size = Math.min(pageSize, input.Limit ?? Infinity);
    const chosen = rows.slice(start, start + size);
    const last = chosen.at(-1);
    return {
      Items: chosen.filter((row) => holds(row, input.FilterExpression, input.ExpressionAttributeNames, input.ExpressionAttributeValues))
        .map((row) => structuredClone(row)),
      LastEvaluatedKey: start + size < rows.length
        ? Object.fromEntries([...tableSchemas[table].key, ...extra].map((name) => [name, last[name]])) : undefined,
    };
  };

  const db = {
    tables,
    failNext: null,
    async send(cmd) {
      const i = cmd.input;
      switch (cmd.constructor.name) {
        case 'ScanCommand':
          return page([...tables[i.TableName].values()], i.TableName, i);
        case 'QueryCommand': {
          const schema = tableSchemas[i.TableName];
          const index = i.IndexName ? schema.indexes[i.IndexName] : schema.key;
          if (!index) throw fail('ValidationException');
          const [, sort] = index;
          const names = i.ExpressionAttributeNames ?? {};
          const values = i.ExpressionAttributeValues ?? {};
          const rows = [...tables[i.TableName].values()]
            .filter((row) => index.every((name) => row[name] !== undefined) && holds(row, i.KeyConditionExpression, names, values))
            .sort((a, b) => sort ? (a[sort] < b[sort] ? -1 : a[sort] > b[sort] ? 1 : 0) : 0);
          if (i.ScanIndexForward === false) rows.reverse();
          return page(rows, i.TableName, i, i.IndexName ? index : []);
        }
        case 'GetCommand': {
          const row = i.ConsistentRead ? tables[i.TableName].get(keyOf(i.TableName, i.Key)) : undefined;
          return { Item: row && structuredClone(row) };
        }
        case 'PutCommand':
        case 'UpdateCommand':
          if (!check(i)) {
            const row = tables[i.TableName].get(keyOf(i.TableName, i.Item ?? i.Key));
            throw fail('ConditionalCheckFailedException', i.ReturnValuesOnConditionCheckFailure && row ? { Item: row } : {});
          }
          apply(i);
          return {};
        case 'TransactWriteCommand': {
          const ops = i.TransactItems.map((t) => t.Update ?? t.Put ?? (t.Delete ? { ...t.Delete, delete: true } : { ...t.ConditionCheck, checkOnly: true }));
          const injected = db.failNext;
          db.failNext = null;
          const reasons = ops.map((op, n) =>
            ({ Code: injected && n === 0 ? injected : check(op) ? 'None' : 'ConditionalCheckFailed' }));
          if (reasons.some((r) => r.Code !== 'None')) throw fail('TransactionCanceledException', { CancellationReasons: reasons });
          ops.filter((op) => !op.checkOnly).forEach(apply);
          return {};
        }
        default:
          throw new Error(`fake db: unhandled ${cmd.constructor.name}`);
      }
    },
  };
  return db;
}
