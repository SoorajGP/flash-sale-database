# SurgeCart: High-Concurrency Flash Sale Architecture & DBMS Foundation

SurgeCart is a high-concurrency ecommerce platform and Database Management Systems (DBMS) project engineered specifically for flash sales and limited-edition product drops.

The system solves the fundamental distributed systems and database challenge of flash sales: **extreme lock contention and race conditions when hundreds or thousands of shoppers attempt to checkout the exact same limited inventory at the exact same millisecond.**

SurgeCart guarantees **0.00% overselling**, **zero negative inventory**, **zero database deadlocks**, and sub-millisecond rejections of excess demand through a **Two-Tier Defense Architecture** combining an in-memory **Redis Lua Stock Shield** with strict **PostgreSQL ACID pessimistic row-level locking (`SELECT ... FOR UPDATE`)**.

---

## Key Capabilities

### 1. High-Concurrency Engine
- **Atomic Stock Shielding:** Redis Lua scripts (`fast_reserve_stock`) absorb massive traffic spikes in RAM, turning away excess buyers in sub-millisecond time and protecting PostgreSQL connection pools.
- **Deterministic Row Locking:** Orders items deterministically (`ORDER BY product_id`) before locking with `SELECT ... FOR UPDATE`, mathematically eliminating cyclic deadlocks.
- **Timed Reservation Window:** Automatically holds stock for 10 minutes during payment processing with inline lazy reclamation and scheduled worker cleanup.
- **Append-Only Movement Audit:** Every stock movement is logged with a unique idempotency key in `inventory_movements`, ensuring full financial auditability and retry safety.

### 2. Storefront Experience
- **Editorial Design System:** Modern editorial styling with typography (`Playfair Display`, `Inter`), responsive layouts, and zero emojis.
- **Live Flash Sale Slider:** Interactive countdown timer and dynamic depletion gauges for live sales.
- **Saved Address Book:** Delivery address management supporting multiple addresses and instant switching during checkout.
- **Product Social Proof:** Verified customer reviews and quantitative rating breakdowns with check constraints.

### 3. Executive Admin Console
- **Unified Workspace:** Dedicated, full-viewport console isolated from storefront navigation.
- **Real-Time Analytics:** Revenue tracking, order settlement status, fulfillment breakdowns, and live catalog velocity rankings.
- **Inventory & Flash Sale Scheduler:** Tools to restock inventory, launch sales, and configure per-customer purchase limits.

---

## High-Concurrency Benchmark Results

The system was evaluated using an automated progressive concurrency harness (`backend/scripts/concurrency_stress_test.py`) that releases simultaneous buyer requests at the exact same microsecond using an asynchronous synchronization barrier.

| Benchmark Tier | Concurrent Requests | Available Stock | Orders Created | Oversell Rate | P50 Latency | P95 Latency | Peak Burst RPS | Status |
| :--- | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: |
| **Tier 1 — Standard Drop** | **100** | 10 | 10 | **0.00%** (0) | 408.7 ms | 673.6 ms | **135.4 req/s** | **100% PERFECT** |
| **Tier 2 — Heavy Drop** | **250** | 25 | 25 | **0.00%** (0) | 1,007.8 ms | 2,217.2 ms | **100.7 req/s** | **100% PERFECT** |
| **Tier 3 — Surge Rush** | **500** | 50 | 50 | **0.00%** (0) | 3,025.2 ms | 6,550.1 ms | **71.2 req/s** | **100% PERFECT** |

### Benchmark Highlights
- **Zero Overselling:** Across 850 total concurrent transactions, exactly 85 orders were created matching the 85 available units. Exactly 765 excess requests were cleanly rejected with HTTP 409 Conflict.
- **Zero Deadlocks:** Zero HTTP 500 internal server errors or transaction serialization failures.
- **Database Reconciliation:** PostgreSQL net available stock (`on_hand - reserved`) evaluated to exactly `0` with zero negative balances.

---

## System Architecture

```text
                  [ 1,000+ Concurrent Flash Sale Buyers ]
                                     │
                                     ▼
┌─────────────────────────────────────────────────────────────────────────┐
│ 1. FastAPI Async Web Tier (Uvicorn)                                     │
│    - Non-blocking asynchronous I/O                                       │
│    - Sliding-window rate limit protection per client/cart               │
└────────────────────────────────────┬────────────────────────────────────┘
                                     │
                                     ▼
┌─────────────────────────────────────────────────────────────────────────┐
│ 2. Redis 7 (In-Memory Stock Shield)                                     │
│    - Runs in system RAM with sub-millisecond execution                  │
│    - Atomic Lua Script: DECRBY stock:product_id                         │
│    - Winners (result >= 0) proceed to database reservation              │
│    - Losers (result < 0) immediately rejected in < 1ms                  │
└────────────────────────────────────┬────────────────────────────────────┘
                                     │ (Only winners reach database)
                                     ▼
┌─────────────────────────────────────────────────────────────────────────┐
│ 3. PostgreSQL 16 (System of Record & ACID Integrity)                    │
│    - Connection Pool: 30 base + 50 overflow connections                 │
│    - SELECT ... FOR UPDATE (deterministic ascending order)              │
│    - Atomic multi-table checkout transaction (orders, items, inventory) │
│    - Immutable price snapshots and append-only audit ledger             │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## Database Design & Relational Schema

PostgreSQL 16 serves as the source of truth. All monetary values are strictly stored as integer cents to eliminate floating-point precision errors.

```text
users ─────< carts ─────< cart_items >───── products ───── inventory
  │             │                                │             │
  │             │                                ├────< product_feedback
  └────< orders <┘                                └────< inventory_movements
             │  │
             │  └────< payments
             └────< order_items

flash_sales ─────< flash_sale_products >──── products

orders / carts ─────< inventory_reservations >──── products
```

<img width="1922" height="3540" alt="surgecart - er diagram" src="https://github.com/user-attachments/assets/6524289a-fee8-4e6d-8ff3-3d734de236d3" />


### Relational Tables & Constraints

| Table | Purpose | Key Integrity Constraints |
| :--- | :--- | :--- |
| `users` | Identity and authentication | Primary Key UUID, Unique `email`, Argon2 password hashes. |
| `products` | Core catalog and specifications | Unique `sku`, Non-negative `price_cents`, JSONB `media_gallery`. |
| `inventory` | Real-time on-hand and reserved balances | Check `on_hand_quantity >= 0`, Check `reserved_quantity >= 0`, Check `reserved_quantity <= on_hand_quantity`. |
| `inventory_movements` | Append-only stock audit ledger | Check `quantity_delta <> 0`, Unique `idempotency_key`. |
| `flash_sales` | Scheduled sale campaigns | Check `ends_at > starts_at`, status enumeration. |
| `flash_sale_products` | Sale allocations and limits | Unique (`flash_sale_id`, `product_id`), allocated quantity and per-customer limits. |
| `carts` / `cart_items` | Shopping intent and sessions | Unique (`cart_id`, `product_id`), Check `quantity > 0`. |
| `orders` / `order_items` | Completed checkout records | Unique `order_number`, immutable snapshots of product name, SKU, and unit price. |
| `inventory_reservations`| 10-minute hold window | Status enumeration (`active`, `committed`, `released`, `expired`), hold expiry timestamp. |
| `product_feedback` | Verified reviews and social proof | Check constraint `1 <= rating_score <= 5`, Foreign Keys to product and user. |

---

## Technology Stack

| Layer | Technology | Rationale |
| :--- | :--- | :--- |
| **Storefront & Admin** | React 19, TypeScript, Vite | Fast client rendering, full type safety, and zero frontend framework overhead. |
| **Styling** | Vanilla CSS Design Tokens | Bespoke editorial design system (`Playfair Display`, British racing forest green, terracotta, warm sand/parchment). |
| **API Backend** | FastAPI, Pydantic v2, Python 3.12+ | High-performance async Python with typed request validation and automatic OpenAPI documentation. |
| **Database** | PostgreSQL 16 | Enterprise ACID guarantees, strict row-level locks, JSONB support, and robust check constraints. |
| **In-Memory Cache** | Redis 7 | Microsecond atomic Lua counters (`fast_reserve_stock`) and sliding-window rate limiters. |
| **Migrations** | Alembic | Complete version-controlled database schema evolution. |
| **Containers** | Docker & Docker Compose | Production-parity local orchestration of PostgreSQL and Redis. |

---

## Running Locally

### Prerequisites
- Docker Desktop
- Python 3.12 or later
- Node.js 20 or later

### 1. Clone and Configure
```powershell
git clone https://github.com/SoorajGP/flash-sale-database.git SurgeCart
cd SurgeCart
Copy-Item .env.example .env
```

### 2. Start PostgreSQL and Redis
```powershell
docker compose up -d
```
Verify both containers are healthy:
```powershell
docker ps
```

### 3. Initialize and Start the Backend
```powershell
cd backend
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -e ".[dev]"
alembic upgrade head
python -m app.seed
uvicorn app.main:app --reload --port 8000
```

Seeded Demo Accounts:
- **Administrator:** `admin@surgecart.local` / `change-this-password`
- **Customer:** `customer@surgecart.local` / `change-this-password`

API Documentation:
- Swagger UI: `http://localhost:8000/docs`
- Healthcheck: `http://localhost:8000/api/v1/health`

### 4. Start the Frontend Storefront & Admin
Open a new terminal window:
```powershell
cd frontend
npm install
npm run dev
```
Visit `http://localhost:5173`. 
- Browse catalog drops and live flash sales.
- Click **Admin Console** (or visit `http://localhost:5173/#admin`) to access the executive analytics dashboard.

---

## Running the Concurrency Benchmark

To test race conditions and concurrency live against your running backend:

```powershell
cd backend
.\.venv\Scripts\python.exe scripts\concurrency_stress_test.py
```

The benchmark stages 100, 250, and 500 simultaneous shoppers and fires all checkout requests across an asynchronous barrier, reporting latency percentiles (P50, P95, P99), throughput (RPS), and database stock integrity.

---

## Repository Structure

```text
.
├── backend/
│   ├── alembic/              # Versioned database migrations
│   │   └── versions/         # 0001 initial schema, 0002 extensions & reviews
│   ├── app/
│   │   ├── api/              # Root API router
│   │   ├── core/             # Redis Lua scripts, security, config
│   │   ├── db/               # SQLAlchemy engine, session, Base model
│   │   ├── modules/          # Domain-driven business modules
│   │   │   ├── carts/        # Cart and cart-item logic
│   │   │   ├── catalog/      # Products, reviews, admin endpoints
│   │   │   ├── inventory/    # Stock, movements, reservation holds
│   │   │   ├── orders/       # High-concurrency checkout and orders
│   │   │   ├── payments/     # Payment confirmation lifecycle
│   │   │   ├── sales/        # Flash sales and product allocations
│   │   │   └── users/        # User accounts, Argon2 hashing, JWT
│   │   └── seed.py           # Database seeder
│   ├── scripts/              # High-concurrency stress test suite
│   └── tests/                # Test suites
├── frontend/
│   ├── src/
│   │   ├── main.tsx          # Storefront, PDP, and Admin workspace
│   │   └── styles.css        # Editorial design system
│   └── index.html
├── docs/                     # Architecture, database schema, API guides
├── docker-compose.yml        # PostgreSQL 16 and Redis 7 services
└── README.md
```

---

## Academic & Evaluation Summary

| Criterion | Implementation in SurgeCart |
| :--- | :--- |
| **Transaction Atomicity** | Multi-table checkout updates (Orders, Items, Inventory, Reservations) run in a single atomic database transaction. |
| **Concurrency Control** | PostgreSQL pessimistic row locks (`SELECT ... FOR UPDATE`) with deterministic ascending ordering to eliminate deadlocks. |
| **Domain Integrity** | Engine-level Check constraints for positive stock, valid hold quantities, rating scores, and chronological dates. |
| **Auditability** | Append-only movement records with unique idempotency keys preventing duplicate operations. |
| **Scalability** | In-memory Redis Lua counter shield preventing database connection exhaustion under burst traffic. |
