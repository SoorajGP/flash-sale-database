# SurgeCart

SurgeCart is a clean, full-stack starting point for an ecommerce store that sells limited products in flash sales. It is intentionally built as a **modular monolith**: a simple shape that is easy to understand and operate now, but keeps clear boundaries for growth later.

The product includes a polished React storefront, customer login, carts, stock reservation, order creation, a safe demo-payment flow, an administrator API, flash-sale management, and a carefully documented PostgreSQL data model.

> This is an MVP foundation, not a production payment system. The payment endpoint is explicitly marked as a demo adapter and must be replaced by a verified provider webhook before taking real money.

## What was built

### Storefront

- A responsive React + TypeScript + Vite storefront.
- A limited-drop hero, product cards, bag counter, checkout feedback, and a sign-in panel.
- It loads live products when the API is available, with a visual fallback so the page still presents correctly while the backend is offline.
- A signed-in administrator sees a small live dashboard in the storefront.

### Customer and commerce APIs

- Account registration and login using Argon2 password hashing and signed bearer tokens.
- Guest carts and cart items.
- Checkout that locks inventory rows before reserving stock.
- Orders and immutable order-item snapshots.
- A ten-minute reservation window while payment is pending.
- Demo payment confirmation that finalizes inventory and marks the order paid.

### Administrator APIs

- Create products with opening inventory.
- Add stock using an idempotency key.
- View a compact sales dashboard.
- Create a flash sale and add a product with a sale price, allocation, and per-customer limit.

### Database and project foundations

- PostgreSQL schema created by one clear, versioned Alembic migration.
- SQLAlchemy models grouped by business module.
- Docker Compose configuration for a local PostgreSQL service.
- Seed data: one local administrator and three sample products.
- Requirements, architecture, database, and API guides in [`docs/`](docs).

## Simple technology stack

| Layer | Choice | Why |
| --- | --- | --- |
| Storefront | React + TypeScript + Vite | Fast local development and a familiar, lightweight UI stack. |
| API | FastAPI + Pydantic | Typed request validation, automatic OpenAPI documentation, and small readable handlers. |
| Persistence | PostgreSQL + SQLAlchemy | Reliable transactions and row locks are essential for a flash sale. |
| Schema history | Alembic | Every database change is versioned and repeatable. |
| Local database | Docker Compose | One command creates a consistent PostgreSQL environment. |
| Authentication | Argon2 + signed bearer token | Passwords are never stored as plain text. |

## Architecture

```text
Browser
  │
  ├── React storefront (Vite, development only)
  │         │
  │         └── /api proxy
  │
  └───────────────> FastAPI modular monolith
                              │
              ┌───────────────┼────────────────┐
              │               │                │
          catalogue        carts/orders    inventory/sales
              │               │                │
              └──────── SQLAlchemy ────────────┘
                              │
                         PostgreSQL
                              │
                         Alembic migrations
```

There is one deployable API and one database. Instead of splitting the system into many services prematurely, business code is separated into modules:

```text
backend/app/modules/
  users/       registration, login, roles
  catalog/     products and admin product operations
  inventory/   current balances, movements, reservations
  sales/       flash sales and their product-specific rules
  carts/       guest cart state
  orders/      checkout and paid orders
  payments/    payment state and provider reference
```

This makes the app easy to navigate: add catalogue behaviour in `catalog`, stock behaviour in `inventory`, and so on. API handlers remain small; multi-table state changes belong in the module that owns the business action.

For more detail, read [docs/architecture.md](docs/architecture.md).

## Database design

PostgreSQL is the source of truth. Money is always an integer number of cents, never a floating-point value.

```text
users ─────< carts ─────< cart_items >───── products ───── inventory
  │             │                                │             │
  └────< orders <┘                                └────< inventory_movements
             │  │
             │  └────< payments
             └────< order_items

flash_sales ─────< flash_sale_products >──── products

orders / carts ─────< inventory_reservations >──── products
```

| Table | What it stores | Key safety rule |
| --- | --- | --- |
| `users` | Customer/admin identity, email, Argon2 password hash, role | Email is unique. |
| `products` | SKU, name, description, regular price and active flag | SKU is unique; price is non-negative cents. |
| `inventory` | Current `on_hand_quantity` and `reserved_quantity` per product | `0 ≤ reserved_quantity ≤ on_hand_quantity`. |
| `inventory_movements` | Append-only stock/audit events | The idempotency key is unique so a retry cannot apply the same movement twice. |
| `flash_sales` | Sale name, status, start and end time | A sale must end after it begins. |
| `flash_sale_products` | Sale price, allocated stock, and customer limit | A product appears once per flash sale. |
| `carts` / `cart_items` | Guest or customer shopping intent | Every cart has a guest session or user; a product appears once in a cart. |
| `orders` / `order_items` | Completed checkout record | Each order item snapshots product name, SKU, and price at checkout. |
| `payments` | Provider state and provider reference | One payment record per order in this MVP. |
| `inventory_reservations` | Temporary stock hold during payment | Quantity is positive and every hold expires. |

The initial migration is [backend/alembic/versions/20261015_0001_initial_schema.py](backend/alembic/versions/20261015_0001_initial_schema.py). It is intentionally explicit: you can see every table, foreign key, index, enum, unique constraint, and check constraint in one place.

For the full relationship guide, read [docs/database.md](docs/database.md).

## How checkout avoids overselling

Flash-sale inventory needs more than a simple “subtract one” query. The checkout path does this in one database transaction:

1. Lock every required `inventory` row with PostgreSQL's `FOR UPDATE` lock.
2. Calculate available stock as `on_hand_quantity - reserved_quantity`.
3. If any requested quantity is unavailable, reject the checkout before creating an order.
4. Create the order, order-item snapshots, payment record, and active inventory reservations.
5. Increase `reserved_quantity` and append an inventory movement for the reservation.
6. On confirmed payment, lock the reservation and inventory rows again, decrease both `on_hand_quantity` and `reserved_quantity`, and mark the reservation/payment/order committed and paid.

This prevents two checkout requests from both buying the last item. It is the most important part of the database design.

### Reservation expiry

Reservations currently expire after ten minutes. The foundation stores the expiry timestamp and makes the payment endpoint reject an expired hold. A production follow-up should add a scheduled worker that releases expired holds by decreasing `reserved_quantity` and writing a `release` movement.

## Payment design: what is real versus demo

The project has a complete `payments` table and checkout/payment state flow, but the last step is a **demo adapter**:

```text
POST /api/v1/orders/{order_id}/pay
```

It immediately marks a pending order as paid so you can test the full reservation and inventory lifecycle without a payment account.

Before real customers use the site:

1. Set `DEMO_PAYMENTS_ENABLED=false`.
2. Create a Stripe Checkout Session or Payment Intent from the checkout endpoint.
3. Receive the payment provider's webhook.
4. Verify the webhook signature.
5. Only then run the same transactional “payment succeeded” logic that finalizes stock.

Never treat a browser redirect or a client-supplied “payment succeeded” value as proof of payment.

## Run locally

### Prerequisites

- Docker Desktop
- Python 3.12 or later
- Node.js 20 or later

### 1. Clone and configure

```powershell
git clone https://github.com/SoorajGP/flash-sale-database.git SurgeCart
cd SurgeCart
Copy-Item .env.example .env
```

The provided `.env.example` works unchanged for local development. Do not use its password or JWT secret in production.

### 2. Start PostgreSQL

```powershell
docker compose up -d postgres
```

The database listens at `localhost:5432` with database/user/password `surgecart` by default.

### 3. Start the API

Open a second PowerShell window:

```powershell
cd backend
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -e ".[dev]"
alembic upgrade head
python -m app.seed
uvicorn app.main:app --reload --port 8000
```

Useful API links:

- API health: `http://localhost:8000/api/v1/health`
- Interactive API documentation: `http://localhost:8000/docs`

The seed command creates:

```text
admin email:    admin@surgecart.local
admin password: change-this-password
```

That account is for local use only. Change it before deploying anywhere.

### 4. Start the storefront

Open a third PowerShell window:

```powershell
cd frontend
npm install
npm run dev
```

Visit `http://localhost:5173`. Vite forwards `/api` calls to FastAPI on port `8000`, so the storefront will display seeded products and can create carts/orders when both apps are running.

### 5. Run checks

```powershell
cd backend
pytest
alembic upgrade head
```

## API overview

All routes use the `/api/v1` prefix.

| Purpose | Route |
| --- | --- |
| Check API health | `GET /health` |
| Register / log in | `POST /auth/register`, `POST /auth/login` |
| View current user | `GET /auth/me` |
| Browse products | `GET /products` |
| Create/read a cart | `POST /carts`, `GET /carts/{cart_id}` |
| Add an item | `POST /carts/{cart_id}/items` |
| Start checkout | `POST /orders/checkout/{cart_id}` |
| Confirm local demo payment | `POST /orders/{order_id}/pay` |
| View live sales | `GET /flash-sales` |
| Admin dashboard | `GET /admin/dashboard` |
| Admin product creation/restock | `POST /admin/products`, `POST /admin/products/{product_id}/restock` |
| Admin flash-sale management | `POST /admin/flash-sales`, `POST /admin/flash-sales/{sale_id}/products` |

Admin routes require a bearer token from the seeded admin login. The FastAPI docs page has an **Authorize** button that lets you paste the returned access token. More detail and payload descriptions are in [docs/api.md](docs/api.md).

## Configuration

| Variable | Purpose | Local default |
| --- | --- | --- |
| `DATABASE_URL` | SQLAlchemy PostgreSQL connection URL | `postgresql+psycopg://surgecart:surgecart@localhost:5432/surgecart` |
| `JWT_SECRET` | Key used to sign login tokens | `change-me-for-production` |
| `DEMO_PAYMENTS_ENABLED` | Enables the local payment confirmation endpoint | `true` |
| `POSTGRES_DB`, `POSTGRES_USER`, `POSTGRES_PASSWORD` | Docker PostgreSQL configuration | `surgecart` |

## Repository map

```text
.
├── backend/
│   ├── alembic/              # migration runner and the initial schema
│   ├── app/
│   │   ├── api/              # root FastAPI router
│   │   ├── core/             # settings and security helpers
│   │   ├── db/               # SQLAlchemy base, connection, model registry
│   │   ├── modules/          # business modules
│   │   └── seed.py           # local admin and sample product data
│   └── tests/                # API smoke test
├── frontend/
│   └── src/                  # Vite/React storefront
├── docs/                     # architecture, data model, API detail
├── docker-compose.yml        # local PostgreSQL
└── .env.example              # local configuration template
```

## What to build next

This first version deliberately keeps the stack compact. High-value next changes are:

1. Replace demo payments with a Stripe adapter and verified webhook.
2. Add an expiry worker that releases timed-out reservations.
3. Add customer order-history endpoints and a richer account page.
4. Add image storage and an admin-facing product/sale editor UI.
5. Add tests for concurrent checkout, payment webhooks, and reservation expiry.
6. Add deployment configuration, secure production secrets, observability, rate limiting, and email receipts.

## Documentation index

- [Architecture](docs/architecture.md)
- [Database guide](docs/database.md)
- [API map](docs/api.md)
- [Milestone requirements](docs/requirements.md)

