// Moves an existing single-shop deployment into the many-shop layout. Run it right after deploying
// the shop stack; it is safe to run again. Uses your AWS CLI credentials and region.
//
//   node migrate-tenancy.mjs --items <ItemsTableName> --reservations <ReservationsTableName> \
//     --tenancy <TenancyTableName> --shop campus-shop --name "Campus stationery shop" \
//     [--owner <Cognito sub of the shopkeeper>] [--hold-minutes 1440]
import { parseArgs } from 'node:util';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { SHOP_ID } from './src/app.mjs';
import { migrateToTenancy } from './src/tenancy-migration.mjs';

const { values } = parseArgs({ options: {
  items: { type: 'string' }, reservations: { type: 'string' }, tenancy: { type: 'string' },
  shop: { type: 'string' }, name: { type: 'string' }, owner: { type: 'string' },
  'pickup-window': { type: 'string', default: '' }, 'hold-minutes': { type: 'string', default: '1440' },
} });
const holdMinutes = Number(values['hold-minutes']);
if (!values.items || !values.reservations || !values.tenancy || !SHOP_ID.test(values.shop ?? '') || !values.name
  || !Number.isSafeInteger(holdMinutes) || holdMinutes < 1
  || (values.owner && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(values.owner))) {
  console.error('Usage: node migrate-tenancy.mjs --items T --reservations T --tenancy T --shop <id> --name <name> [--owner <sub>] [--hold-minutes 1440]');
  process.exit(1);
}
const db = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const counts = await migrateToTenancy(db, values, {
  shopId: values.shop, name: values.name, pickupWindow: values['pickup-window'], ownerId: values.owner, holdMinutes,
});
console.log(JSON.stringify(counts));
if (counts.skipped) console.log(`${counts.skipped} row(s) changed while running; run the command again to finish them.`);
