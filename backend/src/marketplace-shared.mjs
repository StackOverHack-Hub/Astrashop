import { createHash } from 'node:crypto';

const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const hashId = /^[a-f0-9]{64}$/;
const rankId = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z~[a-f0-9-]{36,64}$/;
const control = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u;
const pageSize = 20;
const digest = (...parts) => createHash('sha256').update(JSON.stringify(parts)).digest('hex');
const rank = (when, id) => `${when}~${id}`;
const row = (pk, sk, data) => ({ pk, sk, ...data });
const write = (kind, row, version) => ({ kind, row, version });
const details = (id) => [`LISTING#${id}`, 'DETAIL'];
const account = (id) => `USER#${id}`;
const threadKey = (id) => [`THREAD#${id}`, 'DETAIL'];
class RequestError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
function requireInput(value, message, status = 400) {
  if (!value) throw new RequestError(status, message);
}
const respond = (statusCode, body, headers = {}) => ({
  statusCode,
  headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers },
  body: JSON.stringify(body),
});

function text(value, label, min, max, multiline = false) {
  requireInput(typeof value === 'string' && value.length <= max, `${label} must be ${min}–${max} characters.`);
  const normalized = value.replace(/\r\n?/g, '\n').trim();
  // Required text needs a visible character; zero-width joiners stay allowed for Indic scripts.
  requireInput(normalized.length >= min && (min === 0 || /[\p{L}\p{N}\p{P}\p{S}]/u.test(normalized)) &&
    normalized.isWellFormed() && !control.test(normalized) &&
    (multiline || !/[\t\n]/.test(normalized)),
    `Enter a valid ${label.toLowerCase()} (${min}–${max} characters).`);
  return normalized;
}

function cursorAnchor(cursor, context, accept) {
  if (cursor === undefined) return;
  requireInput(typeof cursor === 'string' && /^[a-zA-Z0-9_-]{1,2048}$/.test(cursor), 'Invalid page cursor.');
  let anchor;
  try {
    const decoded = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (Array.isArray(decoded) && decoded.length === 2 && decoded[0] === context) anchor = decoded[1];
  } catch {
    // Invalid encodings are handled below.
  }
  requireInput(typeof anchor === 'string' && Buffer.byteLength(anchor) < 520 && accept(anchor), 'Invalid page cursor.');
  return anchor;
}

function page(rows, context, present) {
  const chosen = rows.slice(0, pageSize);
  return {
    entries: chosen.map(present),
    next: rows.length > pageSize
      ? Buffer.from(JSON.stringify([context, chosen.at(-1).sk])).toString('base64url')
      : null,
  };
}

export { uuid, hashId, rankId, pageSize, digest, rank, row, write, details, account, threadKey, RequestError, requireInput, respond, text, cursorAnchor, page };
