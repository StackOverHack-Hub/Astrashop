import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { makeMarketplace } from './marketplace.mjs';
import { dynamoMarketplace } from './marketplace-store.mjs';
import { redisLimiter } from './marketplace-limit.mjs';

const db = DynamoDBDocumentClient.from(new DynamoDBClient({
  maxAttempts: 2,
  requestHandler: { connectionTimeout: 1100, requestTimeout: 2000, throwOnRequestTimeout: true },
}));

export const handler = makeMarketplace(
  dynamoMarketplace(db, process.env.MARKETPLACE_TABLE),
  redisLimiter({ host: process.env.REDIS_HOST, port: Number(process.env.REDIS_PORT), password: process.env.REDIS_PASSWORD }),
);
