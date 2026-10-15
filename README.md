# SurgeCart

SurgeCart is a modular-monolith foundation for flash-sale commerce. This first milestone establishes the project shape, core data model, an initial database migration, and small runnable API and web clients.

## What is included

- React + TypeScript + Vite storefront with a polished product drop, bag, checkout cue, and login UI.
- FastAPI application for registration/login, products, guest carts, reservation-based checkout, demo payments, orders, flash sales, and admin operations.
- PostgreSQL schema managed with SQLAlchemy and Alembic.
- Core domains: catalog, inventory, flash sales, carts, orders, and inventory reservations.
- Architecture, requirements, and database-concurrency notes in [`docs/`](docs).

Read the [API map](docs/api.md) and [database guide](docs/database.md) before extending checkout behavior.

## Quick start

### 1. Start PostgreSQL

Copy `.env.example` to `.env` if you want to change the defaults, then run:

```powershell
docker compose up -d postgres
```

### 2. Run the API

Requires Python 3.12+.

```powershell
cd backend
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -e ".[dev]"
alembic upgrade head
python -m app.seed
uvicorn app.main:app --reload --port 8000
```

Visit `http://localhost:8000/docs` for the OpenAPI interface. `GET /api/v1/health` should return `{"status":"ok"}`.

The seed command creates `admin@surgecart.local` with password `change-this-password`; change it before any real deployment.

### 3. Run the web app

Requires Node 20+.

```powershell
cd frontend
npm install
npm run dev
```

The web app starts at `http://localhost:5173` and calls the API health route through Vite's `/api` proxy.

## Checks

```powershell
cd backend
pytest
alembic upgrade head
```

`pytest` uses SQLite for the small API smoke test; the migration target is PostgreSQL and should be applied to the Docker service for schema verification.

## Payment safety

The checkout flow intentionally uses a demo payment record so it runs without payment-provider credentials. It reserves stock for ten minutes, then `POST /api/v1/orders/{order_id}/pay` commits the inventory hold. For production, set `DEMO_PAYMENTS_ENABLED=false`, replace the demo endpoint with Stripe Checkout or Payment Intents, and update payment/order state only from verified provider webhooks.

## Next milestone

Implement transactional reservation and checkout services: lock inventory rows, create idempotent movements, expire carts/reservations, and expose authenticated catalog/cart/checkout endpoints. See [`docs/architecture.md`](docs/architecture.md) for the required consistency rules.

