// FILE: api/src/shared/chunk.js
// Training Wire — body chunking helper.
// Azure Table Storage caps a single property at 64KB and a whole entity at ~1MB.
// Release bodies (formatted HTML + plain text) routinely exceed 64KB, which is why
// writing them into one property threw "Could not save release". This splits any
// large string across multiple ~32KB properties (body0, body1, …) and rejoins them
// on read. Uses ONLY strings the @azure/data-tables SDK already stores natively.
'use strict';

// 32KB per chunk (UTF-16 code units). Stays safely under the 64KB property cap
// even after the SDK's internal encoding overhead.
const CHUNK_SIZE = 32 * 1024;

// Hard ceiling so a monster PDF can't blow the ~1MB entity limit. We budget ~28
// chunks (~900KB) which leaves headroom for the other metadata properties.
const MAX_CHUNKS = 28;

// Split a string into chunk properties. Returns an object you spread into the
// entity: { <prefix>N: 'chunks', <prefix>Chunks: count }.
// Throws a clean, user-facing error if the body is too large to store.
function splitBody(str, prefix) {
  const s = String(str == null ? '' : str);
  const out = {};
  if (s.length === 0) {
    out[prefix + 'Chunks'] = 0;
    return out;
  }
  const count = Math.ceil(s.length / CHUNK_SIZE);
  if (count > MAX_CHUNKS) {
    const err = new Error('This release is too large to store (over ~900KB of content).');
    err.code = 'BODY_TOO_LARGE';
    throw err;
  }
  for (let i = 0; i < count; i++) {
    out[prefix + i] = s.slice(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE);
  }
  out[prefix + 'Chunks'] = count;
  return out;
}

// Rejoin chunk properties back into the original string.
function joinBody(entity, prefix) {
  if (!entity) return '';
  const count = Number(entity[prefix + 'Chunks'] || 0);
  if (!count) return '';
  let s = '';
  for (let i = 0; i < count; i++) {
    s += String(entity[prefix + i] || '');
  }
  return s;
}

module.exports = { splitBody, joinBody, CHUNK_SIZE, MAX_CHUNKS };
