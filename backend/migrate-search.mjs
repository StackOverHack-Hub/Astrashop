// Moves marketplace listings saved before word search onto word rows, so search finds them again.
// Run it once right after deploying the marketplace with word search; it is safe to run again.
//
//   node migrate-search.mjs <MarketplaceTableName>      (uses your AWS CLI credentials and region)
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { backfillListingWords } from './src/marketplace.mjs';
import { dynamoMarketplace } from './src/marketplace-store.mjs';

const table = process.argv[2];
if (!table) {
  console.error('Usage: node migrate-search.mjs <MarketplaceTableName>');
  process.exit(1);
}
const moved = await backfillListingWords(dynamoMarketplace(DynamoDBDocumentClient.from(new DynamoDBClient({})), table));
console.log(`Moved ${moved} listing(s) onto word search.`);
