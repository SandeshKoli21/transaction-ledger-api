const { openDb } = require('./db');
const { createLedger } = require('./ledger');
const { createApp } = require('./app');

const PORT = Number(process.env.PORT) || 3000;
createApp(createLedger(openDb())).listen(PORT, () => {
  console.log(`Ledger API running on http://localhost:${PORT}`);
});
