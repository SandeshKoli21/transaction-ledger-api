// End-to-end tests for every rule in the assignment. Run: npm test
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { openDb } = require('../src/db');
const { createLedger } = require('../src/ledger');
const { createApp } = require('../src/app');

let server, base, db;
before(async () => {
  db = openDb(':memory:');
  server = createApp(createLedger(db));
  await new Promise((r) => server.listen(0, r));
  base = `http://localhost:${server.address().port}`;
});
after(() => server.close());

const call = async (method, path, body) => {
  const res = await fetch(base + path, {
    method, headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
};
const newAccount = async (name = 'Asha') => (await call('POST', '/accounts', { name })).body;
const tx = (id, type, amount, reference_id, description = 'test') =>
  call('POST', `/accounts/${id}/transactions`, { type, amount, reference_id, description });

test('create account: balance starts at 0, system sets id and created_at', async () => {
  const r = await call('POST', '/accounts', { name: 'Ravi' });
  assert.equal(r.status, 201);
  assert.equal(r.body.balance, 0);
  assert.ok(r.body.id && r.body.created_at);
});

test('create account: name required, client cannot set balance', async () => {
  assert.equal((await call('POST', '/accounts', {})).status, 400);
  const r = await call('POST', '/accounts', { name: 'X', balance: 500 });
  assert.equal(r.status, 400);
  assert.equal(r.body.error.code, 'VALIDATION_ERROR');
});

test('credit and debit update balance; example from brief ends at 100', async () => {
  const a = await newAccount();
  await tx(a.id, 'credit', 100, 'r1');
  await tx(a.id, 'credit', 50, 'r2');
  await tx(a.id, 'debit', 30, 'r3');
  await tx(a.id, 'debit', 20, 'r4');
  assert.deepEqual((await call('GET', `/accounts/${a.id}/balance`)).body, { account_id: a.id, balance: 100 });
});

test('debit rejected on insufficient balance and balance unchanged', async () => {
  const a = await newAccount();
  await tx(a.id, 'credit', 100, 'c1');
  const r = await tx(a.id, 'debit', 150, 'd1');
  assert.equal(r.status, 422);
  assert.equal(r.body.error.code, 'INSUFFICIENT_BALANCE');
  assert.equal((await call('GET', `/accounts/${a.id}/balance`)).body.balance, 100);
});

test('duplicate reference_id: no new transaction, balance unchanged, 409', async () => {
  const a = await newAccount();
  await tx(a.id, 'credit', 100, 'same');
  const r = await tx(a.id, 'credit', 100, 'same');
  assert.equal(r.status, 409);
  assert.equal(r.body.error.code, 'DUPLICATE_TRANSACTION');
  assert.equal((await call('GET', `/accounts/${a.id}/balance`)).body.balance, 100);
  assert.equal((await call('GET', `/accounts/${a.id}/transactions`)).body.pagination.total_records, 1);
});

test('same reference_id allowed on different accounts', async () => {
  const a = await newAccount(); const b = await newAccount();
  assert.equal((await tx(a.id, 'credit', 10, 'shared')).status, 201);
  assert.equal((await tx(b.id, 'credit', 10, 'shared')).status, 201);
});

test('validation errors: type, amount, reference_id, bad JSON, unknown account', async () => {
  const a = await newAccount();
  assert.equal((await tx(a.id, 'refund', 10, 'v1')).status, 400);
  assert.equal((await tx(a.id, 'credit', 0, 'v2')).status, 400);
  assert.equal((await tx(a.id, 'credit', -5, 'v3')).status, 400);
  assert.equal((await tx(a.id, 'credit', '10', 'v4')).status, 400);
  assert.equal((await tx(a.id, 'credit', 1.234, 'v5')).status, 400);
  assert.equal((await call('POST', `/accounts/${a.id}/transactions`, { type: 'credit', amount: 5 })).status, 400);
  assert.equal((await call('POST', `/accounts/${a.id}/transactions`, '{bad json')).status, 400);
  const nf = await tx('no-such-id', 'credit', 10, 'v6');
  assert.equal(nf.status, 404);
  assert.equal(nf.body.error.code, 'ACCOUNT_NOT_FOUND');
  assert.equal((await call('GET', '/accounts/no-such-id/balance')).status, 404);
});

test('history: latest first, filter by type, pagination info', async () => {
  const a = await newAccount();
  for (let i = 1; i <= 5; i++) await tx(a.id, 'credit', i, `h${i}`);
  await tx(a.id, 'debit', 1, 'h6');
  const all = (await call('GET', `/accounts/${a.id}/transactions?page=1&limit=4`)).body;
  assert.equal(all.data.length, 4);
  assert.equal(all.data[0].reference_id, 'h6');
  assert.deepEqual(all.pagination, { page: 1, limit: 4, total_records: 6, total_pages: 2 });
  const p2 = (await call('GET', `/accounts/${a.id}/transactions?page=2&limit=4`)).body;
  assert.equal(p2.data.length, 2);
  const credits = (await call('GET', `/accounts/${a.id}/transactions?type=credit`)).body;
  assert.ok(credits.data.every((t) => t.type === 'credit'));
  assert.equal(credits.pagination.total_records, 5);
  assert.equal((await call('GET', `/accounts/${a.id}/transactions?page=0`)).status, 400);
  assert.equal((await call('GET', `/accounts/${a.id}/transactions?limit=abc`)).status, 400);
  assert.equal((await call('GET', `/accounts/${a.id}/transactions?type=x`)).status, 400);
});

test('transactions are immutable: no edit/delete via API or database', async () => {
  const a = await newAccount();
  await tx(a.id, 'credit', 10, 'imm');
  assert.equal((await call('DELETE', `/accounts/${a.id}/transactions`)).status, 405);
  assert.equal((await call('PUT', `/accounts/${a.id}/transactions`, {})).status, 405);
  assert.throws(() => db.prepare('UPDATE transactions SET amount = 1').run(), /immutable/);
  assert.throws(() => db.prepare('DELETE FROM transactions').run(), /immutable/);
});

test('bonus transfer: 100/50, move 30 -> 70/80', async () => {
  const a = await newAccount('A'); const b = await newAccount('B');
  await tx(a.id, 'credit', 100, 'a0'); await tx(b.id, 'credit', 50, 'b0');
  const r = await call('POST', '/transfers', { from_account_id: a.id, to_account_id: b.id, amount: 30, reference_id: 't1' });
  assert.equal(r.status, 201);
  assert.equal((await call('GET', `/accounts/${a.id}/balance`)).body.balance, 70);
  assert.equal((await call('GET', `/accounts/${b.id}/balance`)).body.balance, 80);
});

test('bonus transfer is all-or-nothing', async () => {
  const a = await newAccount('A'); const b = await newAccount('B');
  await tx(a.id, 'credit', 100, 'a0');
  // insufficient balance
  assert.equal((await call('POST', '/transfers', { from_account_id: a.id, to_account_id: b.id, amount: 500, reference_id: 'x1' })).status, 422);
  // destination missing
  assert.equal((await call('POST', '/transfers', { from_account_id: a.id, to_account_id: 'ghost', amount: 10, reference_id: 'x2' })).status, 404);
  // second leg fails (destination already used this reference_id) -> source debit must be rolled back
  await tx(b.id, 'credit', 1, 'x3');
  assert.equal((await call('POST', '/transfers', { from_account_id: a.id, to_account_id: b.id, amount: 10, reference_id: 'x3' })).status, 409);
  assert.equal((await call('GET', `/accounts/${a.id}/balance`)).body.balance, 100);
  assert.equal((await call('GET', `/accounts/${a.id}/transactions`)).body.pagination.total_records, 1);
  // same account
  assert.equal((await call('POST', '/transfers', { from_account_id: a.id, to_account_id: a.id, amount: 10, reference_id: 'x4' })).status, 400);
});

test('decimal amounts are exact (0.1 + 0.2 = 0.3)', async () => {
  const a = await newAccount();
  await tx(a.id, 'credit', 0.1, 'd1'); await tx(a.id, 'credit', 0.2, 'd2');
  assert.equal((await call('GET', `/accounts/${a.id}/balance`)).body.balance, 0.3);
});

test('unknown route returns 404 JSON', async () => {
  const r = await call('GET', '/nope');
  assert.equal(r.status, 404);
  assert.equal(r.body.error.code, 'NOT_FOUND');
});
