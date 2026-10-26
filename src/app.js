// HTTP layer: routing, JSON parsing and consistent error responses. No framework needed.
const http = require('node:http');
const { AppError } = require('./errors');
const validate = require('./validate');

function send(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > 1e6) reject(new AppError(413, 'PAYLOAD_TOO_LARGE', 'Request body is too large'));
    });
    req.on('end', () => {
      if (!data) return resolve({});
      try {
        const parsed = JSON.parse(data);
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
          return reject(new AppError(400, 'INVALID_BODY', 'Request body must be a JSON object'));
        }
        resolve(parsed);
      } catch {
        reject(new AppError(400, 'INVALID_BODY', 'Request body is not valid JSON'));
      }
    });
    req.on('error', reject);
  });
}

function createApp(ledger) {
  const routes = [
    ['POST', /^\/accounts$/, async (req) => [201, ledger.createAccount(validate.account(await readJson(req)).name)]],
    ['GET', /^\/accounts\/([^/]+)\/balance$/, async (_req, [id]) => [200, ledger.getBalance(id)]],
    ['POST', /^\/accounts\/([^/]+)\/transactions$/, async (req, [id]) =>
      [201, ledger.addTransaction(id, validate.transaction(await readJson(req)))]],
    ['GET', /^\/accounts\/([^/]+)\/transactions$/, async (_req, [id], url) =>
      [200, ledger.listTransactions(id, validate.pagination(url.searchParams))]],
    ['POST', /^\/transfers$/, async (req) => [201, ledger.transfer(validate.transfer(await readJson(req)))]],
  ];

  return http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    try {
      const matches = routes.filter(([, re]) => re.test(url.pathname));
      if (!matches.length) throw new AppError(404, 'NOT_FOUND', 'Route not found');
      const route = matches.find(([m]) => m === req.method);
      // No PUT/PATCH/DELETE routes exist, so transactions cannot be edited or deleted.
      if (!route) throw new AppError(405, 'METHOD_NOT_ALLOWED', `${req.method} is not allowed on this route`);
      const params = route[1].exec(url.pathname).slice(1).map(decodeURIComponent);
      const [status, body] = await route[2](req, params, url);
      send(res, status, body);
    } catch (err) {
      if (err instanceof AppError) {
        send(res, err.status, { error: { code: err.code, message: err.message, ...(err.details && { details: err.details }) } });
      } else {
        console.error(err);
        send(res, 500, { error: { code: 'INTERNAL_ERROR', message: 'Something went wrong' } });
      }
    }
  });
}

module.exports = { createApp };
