// Database setup. Uses Node's built-in SQLite (Node 22.5+), so there is nothing to install.
const { DatabaseSync } = require('node:sqlite');

function openDb(file = process.env.DB_FILE || 'ledger.db') {
  const db = new DatabaseSync(file);
  db.exec(`
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS accounts (
      id         TEXT PRIMARY KEY,
      name       TEXT NOT NULL,
      balance    INTEGER NOT NULL DEFAULT 0 CHECK (balance >= 0),
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS transactions (
      id           TEXT PRIMARY KEY,
      account_id   TEXT NOT NULL REFERENCES accounts(id),
      type         TEXT NOT NULL CHECK (type IN ('credit','debit')),
      amount       INTEGER NOT NULL CHECK (amount > 0),
      description  TEXT,
      reference_id TEXT NOT NULL,
      created_at   TEXT NOT NULL,
      seq          INTEGER NOT NULL,
      UNIQUE (account_id, reference_id)
    );

    CREATE INDEX IF NOT EXISTS idx_tx_account_time
      ON transactions(account_id, created_at DESC, seq DESC);

    -- A ledger is a permanent record: the database itself refuses edits and deletes.
    CREATE TRIGGER IF NOT EXISTS no_update_tx BEFORE UPDATE ON transactions
      BEGIN SELECT RAISE(ABORT, 'transactions are immutable'); END;
    CREATE TRIGGER IF NOT EXISTS no_delete_tx BEFORE DELETE ON transactions
      BEGIN SELECT RAISE(ABORT, 'transactions are immutable'); END;
  `);
  return db;
}

module.exports = { openDb };
