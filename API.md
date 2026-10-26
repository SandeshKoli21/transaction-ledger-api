# API Documentation

Base URL: `http://localhost:3000` · All requests and responses are JSON.

## Error format (all errors)

```json
{ "error": { "code": "INSUFFICIENT_BALANCE", "message": "Insufficient balance for this debit", "details": { "balance": 100, "requested": 150 } } }
```

| Status | Code | When |
|---|---|---|
| 400 | `VALIDATION_ERROR` | Missing/invalid fields or query params (`details.errors` lists each problem) |
| 400 | `INVALID_BODY` | Body is not valid JSON or not an object |
| 404 | `ACCOUNT_NOT_FOUND` | Account ID does not exist |
| 404 | `NOT_FOUND` | Unknown route |
| 405 | `METHOD_NOT_ALLOWED` | e.g. PUT/DELETE on transactions (they are immutable) |
| 409 | `DUPLICATE_TRANSACTION` | `reference_id` already used on this account |
| 422 | `INSUFFICIENT_BALANCE` | Debit/transfer larger than the balance |
| 500 | `INTERNAL_ERROR` | Unexpected server error |

---

## 1. Create account
`POST /accounts`

```json
{ "name": "Asha" }
```

**201 Created**
```json
{ "id": "6f1c...", "name": "Asha", "balance": 0, "created_at": "2026-10-26T11:00:00.000Z" }
```
Errors: `400` if `name` is missing, or if `balance`, `id` or `created_at` is sent.

---

## 2. Add transaction
`POST /accounts/{account_id}/transactions`

```json
{ "type": "credit", "amount": 50, "reference_id": "inv-1001", "description": "Top-up" }
```

| Field | Rules |
|---|---|
| `type` | required, `credit` or `debit` |
| `amount` | required number, > 0, max 2 decimals |
| `reference_id` | required, unique per account |
| `description` | optional string, max 500 |

**201 Created**
```json
{
  "transaction": { "id": "a9e2...", "account_id": "6f1c...", "type": "credit", "amount": 50,
                   "description": "Top-up", "reference_id": "inv-1001", "created_at": "2026-10-26T11:01:00.000Z" },
  "balance": 150
}
```
Errors: `400`, `404`, `409` (balance unchanged, `details.transaction` is the original), `422` (balance unchanged).

---

## 3. Get balance
`GET /accounts/{account_id}/balance`

**200 OK**
```json
{ "account_id": "6f1c...", "balance": 150 }
```
Errors: `404`.

---

## 4. Transaction history
`GET /accounts/{account_id}/transactions?type=credit&page=1&limit=10`

| Param | Default | Rules |
|---|---|---|
| `type` | both | `credit` or `debit` |
| `page` | 1 | positive integer |
| `limit` | 10 | positive integer, max 100 |

Sorted latest first by `created_at`.

**200 OK**
```json
{
  "data": [ { "id": "...", "type": "credit", "amount": 50, "reference_id": "inv-1001", "...": "..." } ],
  "pagination": { "page": 1, "limit": 10, "total_records": 6, "total_pages": 1 }
}
```
Errors: `400` (bad `type`/`page`/`limit`), `404`.

---

## 5. Transfer (bonus)
`POST /transfers`

```json
{ "from_account_id": "A...", "to_account_id": "B...", "amount": 30, "reference_id": "tr-1", "description": "Rent share" }
```

**201 Created**
```json
{
  "reference_id": "tr-1", "amount": 30,
  "from": { "account_id": "A...", "balance": 70, "transaction": { "type": "debit", "...": "..." } },
  "to":   { "account_id": "B...", "balance": 80, "transaction": { "type": "credit", "...": "..." } }
}
```
Atomic: if any check fails (missing account, insufficient balance, duplicate `reference_id` on either side), **nothing** is written.
Errors: `400` (incl. same account), `404`, `409`, `422`.
