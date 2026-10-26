// Business rules for accounts, transactions and transfers.
// Amounts are stored as integers in the smallest unit (paise) to avoid floating-point errors.
const crypto = require('node:crypto');
const { AppError } = require('./errors');

const toMinor = (amount) => Math.round(amount * 100);
const toMajor = (minor) => minor / 100;
const now = () => new Date().toISOString();
// Keeps every balance well inside JavaScript's exact-integer range (2^53 paise).
const MAX_BALANCE_MINOR = 1e15;

function createLedger(db) {
  let seq = Number(db.prepare('SELECT COALESCE(MAX(seq),0) AS s FROM transactions').get().s);

  // Run fn inside one database transaction: either everything is saved, or nothing is.
  function atomic(fn) {
    db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      db.exec('COMMIT');
      return result;
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }

  const q = {
    insertAccount: db.prepare('INSERT INTO accounts (id, name, balance, created_at) VALUES (?, ?, 0, ?)'),
    getAccount: db.prepare('SELECT id, name, balance, created_at FROM accounts WHERE id = ?'),
    setBalance: db.prepare('UPDATE accounts SET balance = ? WHERE id = ?'),
    findByRef: db.prepare('SELECT * FROM transactions WHERE account_id = ? AND reference_id = ?'),
    insertTx: db.prepare(`INSERT INTO transactions
      (id, account_id, type, amount, description, reference_id, created_at, seq)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`),
    count: (typed) => db.prepare(`SELECT COUNT(*) AS n FROM transactions WHERE account_id = ?${typed ? ' AND type = ?' : ''}`),
    page: (typed) => db.prepare(`SELECT * FROM transactions WHERE account_id = ?${typed ? ' AND type = ?' : ''}
      ORDER BY created_at DESC, seq DESC LIMIT ? OFFSET ?`),
  };

  const accountOut = (a) => ({ id: a.id, name: a.name, balance: toMajor(Number(a.balance)), created_at: a.created_at });
  const txOut = (t) => ({
    id: t.id, account_id: t.account_id, type: t.type, amount: toMajor(Number(t.amount)),
    description: t.description, reference_id: t.reference_id, created_at: t.created_at,
  });

  function mustGetAccount(id) {
    const a = q.getAccount.get(id);
    if (!a) throw new AppError(404, 'ACCOUNT_NOT_FOUND', `Account '${id}' does not exist`);
    return a;
  }

  // Applies one credit/debit to an account. Must be called inside atomic().
  function applyTx(accountId, { type, amount, description, reference_id }) {
    const account = mustGetAccount(accountId);

    const existing = q.findByRef.get(accountId, reference_id);
    if (existing) {
      throw new AppError(409, 'DUPLICATE_TRANSACTION',
        `A transaction with reference_id '${reference_id}' already exists for this account`,
        { transaction: txOut(existing) });
    }

    const minor = toMinor(amount);
    const current = Number(account.balance);
    if (type === 'debit' && current < minor) {
      throw new AppError(422, 'INSUFFICIENT_BALANCE', 'Insufficient balance for this debit',
        { balance: toMajor(current), requested: amount });
    }
    const next = type === 'credit' ? current + minor : current - minor;
    if (next > MAX_BALANCE_MINOR) {
      throw new AppError(422, 'BALANCE_LIMIT_EXCEEDED', 'This credit would take the balance past the maximum allowed',
        { balance: toMajor(current), requested: amount, max_balance: toMajor(MAX_BALANCE_MINOR) });
    }

    const tx = {
      id: crypto.randomUUID(), account_id: accountId, type, amount: minor,
      description: description ?? null, reference_id, created_at: now(), seq: ++seq,
    };
    q.insertTx.run(tx.id, tx.account_id, tx.type, tx.amount, tx.description, tx.reference_id, tx.created_at, tx.seq);
    q.setBalance.run(next, accountId);
    return { transaction: txOut(tx), balance: toMajor(next) };
  }

  return {
    createAccount(name) {
      const id = crypto.randomUUID();
      q.insertAccount.run(id, name, now());
      return accountOut(q.getAccount.get(id));
    },

    getBalance(id) {
      const a = mustGetAccount(id);
      return { account_id: a.id, balance: toMajor(Number(a.balance)) };
    },

    addTransaction(accountId, input) {
      return atomic(() => applyTx(accountId, input));
    },

    listTransactions(accountId, { type, page, limit }) {
      mustGetAccount(accountId);
      const typed = Boolean(type);
      const args = typed ? [accountId, type] : [accountId];
      const total = Number(q.count(typed).get(...args).n);
      const rows = q.page(typed).all(...args, limit, (page - 1) * limit);
      return {
        data: rows.map(txOut),
        pagination: { page, limit, total_records: total, total_pages: Math.ceil(total / limit) },
      };
    },

    // Bonus: debit source + credit destination as one all-or-nothing operation.
    transfer({ from_account_id, to_account_id, amount, description, reference_id }) {
      return atomic(() => {
        mustGetAccount(from_account_id);
        mustGetAccount(to_account_id);
        const debit = applyTx(from_account_id, { type: 'debit', amount, description, reference_id });
        const credit = applyTx(to_account_id, { type: 'credit', amount, description, reference_id });
        return {
          reference_id, amount,
          from: { account_id: from_account_id, balance: debit.balance, transaction: debit.transaction },
          to: { account_id: to_account_id, balance: credit.balance, transaction: credit.transaction },
        };
      });
    },
  };
}

module.exports = { createLedger };
