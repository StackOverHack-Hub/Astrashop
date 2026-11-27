// Keys and indexes for DynamoDB Local and the in-memory test database (fake-db.mjs).
// template.yaml declares the same layout for AWS. Every index projects whole rows.
export const tableSchemas = {
  items: { key: ['id'], indexes: { ByShop: ['shopId', 'name'] } },
  // queueShop is set only while a hold needs the counter (held, or expired and not yet back on the shelf),
  // so this index stays as small as the counter's to-do list.
  reservations: { key: ['id'], indexes: { Queue: ['queueShop', 'expiresAt'], ByShopCreated: ['shopId', 'createdAt'] } },
  tenancy: { key: ['pk', 'sk'], ttl: 'expires' },
  marketplace: { key: ['pk', 'sk'], ttl: 'expires' },
};
