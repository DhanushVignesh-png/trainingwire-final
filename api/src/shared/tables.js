// FILE: api/src/shared/tables.js
// Training Wire — Azure Table Storage helpers
// Thin wrapper around @azure/data-tables. Auto-creates tables on first use,
// gives simple upsert/merge/get/remove/list, plus clearPartition used by /api/clear.
'use strict';

const { TableClient } = require('@azure/data-tables');
const { ENV, requireEnv } = require('./config');

const _clients = {};

// Get (and cache) a TableClient for a given table name.
function getTable(tableName) {
  requireEnv(['TABLES_CONNECTION']);
  if (_clients[tableName]) return _clients[tableName];
  const client = TableClient.fromConnectionString(ENV.TABLES_CONNECTION, tableName, {
    allowInsecureConnection: false,
  });
  _clients[tableName] = client;
  return client;
}

// Ensure a table exists (safe to call repeatedly; ignores "already exists").
async function ensureTable(tableName) {
  const client = getTable(tableName);
  try {
    await client.createTable();
  } catch (e) {
    if (!(e && (e.statusCode === 409 || /TableAlreadyExists/i.test(e.message || '')))) {
      throw e;
    }
  }
  return client;
}

// Upsert (insert or replace). entity must have partitionKey + rowKey.
async function upsert(tableName, entity) {
  const client = await ensureTable(tableName);
  await client.upsertEntity(entity, 'Replace');
  return entity;
}

// Merge (partial update) — only provided fields change.
async function merge(tableName, entity) {
  const client = await ensureTable(tableName);
  await client.upsertEntity(entity, 'Merge');
  return entity;
}

// Get a single entity. Returns null if it doesn't exist.
async function get(tableName, partitionKey, rowKey) {
  const client = await ensureTable(tableName);
  try {
    return await client.getEntity(partitionKey, rowKey);
  } catch (e) {
    if (e && e.statusCode === 404) return null;
    throw e;
  }
}

// Delete a single entity. Safe if it's already gone.
async function remove(tableName, partitionKey, rowKey) {
  const client = await ensureTable(tableName);
  try {
    await client.deleteEntity(partitionKey, rowKey);
  } catch (e) {
    if (!(e && e.statusCode === 404)) throw e;
  }
}

// List entities.
// opts:
//   { partitionKey: 'x' }  → filter to one partition
//   {} or undefined        → whole table
//   { filter: "..." }      → raw OData filter (advanced)
async function list(tableName, opts) {
  const client = await ensureTable(tableName);
  let queryOptions;
  if (opts && typeof opts === 'object') {
    if (opts.filter) {
      queryOptions = { filter: opts.filter };
    } else if (opts.partitionKey) {
      const pk = String(opts.partitionKey).replace(/'/g, "''");
      queryOptions = { filter: `PartitionKey eq '${pk}'` };
    }
  } else if (typeof opts === 'string' && opts) {
    // Back-compat: a bare string is treated as a partitionKey.
    const pk = opts.replace(/'/g, "''");
    queryOptions = { filter: `PartitionKey eq '${pk}'` };
  }
  const out = [];
  for await (const e of client.listEntities(queryOptions ? { queryOptions } : undefined)) {
    out.push(e);
  }
  return out;
}

// Delete every row in a single partition. Returns count deleted.
// Used by /api/clear for a global session reset.
async function clearPartition(tableName, partitionKey) {
  const client = await ensureTable(tableName);
  const pk = String(partitionKey).replace(/'/g, "''");
  const toDelete = [];
  for await (const e of client.listEntities({
    queryOptions: { filter: `PartitionKey eq '${pk}'` },
  })) {
    toDelete.push({ partitionKey: e.partitionKey, rowKey: e.rowKey });
  }
  let count = 0;
  for (const e of toDelete) {
    try { await client.deleteEntity(e.partitionKey, e.rowKey); count++; }
    catch (err) { if (!(err && err.statusCode === 404)) throw err; }
  }
  return count;
}

module.exports = {
  getTable, ensureTable, upsert, merge, get, remove, list, clearPartition,
};