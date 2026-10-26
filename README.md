# SurgeCart: High-Concurrency Flash Sale Architecture & DBMS Foundation

SurgeCart is an enterprise-grade, high-concurrency flash sale platform and Database Management Systems (DBMS) project engineered specifically to withstand the extreme write contention of limited-edition product drops.

The system solves the hardest problem in distributed ecommerce: **massive traffic spikes where tens or hundreds of thousands of shoppers race to checkout the exact same limited inventory at the exact same millisecond.**

SurgeCart guarantees **0.00% overselling**, **zero negative inventory**, **zero database deadlocks**, and sub-millisecond rejection of excess demand through a multi-tier defense architecture combining **CQRS read-replica routing**, **native PostgreSQL date-range table partitioning**, an **in-memory Virtual Waiting Room (Leaky Bucket / Token Bucket)**, an **automated FIFO Restock Waitlist**, an **in-memory Redis Lua Stock Shield**, and strict **PostgreSQL ACID pessimistic row-level locking (`SELECT ... FOR UPDATE`)**.

---

## Benchmark Results: 1,850 Concurrent Buyers Firing Simultaneously

Evaluated using an automated progressive concurrency harness ([backend/scripts/concurrency_stress_test.py](file:///c:/Users/SOORAJ/flash-sale-website/backend/scripts/concurrency_stress_test.py)) that stages independent buyers and releases all checkout requests across an asynchronous synchronization barrier at the exact same millisecond.

```text
####################################################################################
           SURGECART HIGH-CONCURRENCY FLASH SALE PITCH BENCHMARK
####################################################################################
TIER                   | REQUESTS  | STOCK  | ORDERS  | OVERSELL  | P50 (ms)  | P95 (ms)  | RPS      | STATUS 
----------------------------------------------------------------------------------------------------------------
Tier 1 - Standard Drop | 100       | 10     | 10      | 0         | 408.0     | 657.2     | 138.3    | 100% PERFECT
Tier 2 - Heavy Drop    | 250       | 25     | 25      | 0         | 1053.1    | 1741.4    | 128.8    | 100% PERFECT
Tier 3 - Surge Rush    | 500       | 50     | 50      | 0         | 2402.1    | 6875.8    | 68.7     | 100% PERFECT
Tier 4 - Mega Drop     | 1000      | 50     | 50      | 0         | 7232.7    | 9637.1    | 96.6     | 100% PERFECT
----------------------------------------------------------------------------------------------------------------
```

### Key Engineering Proof Points:
- **0.00% Oversell Rate:** Out of 1,850 simultaneous checkout requests, exactly 135 orders were created for the 135 available units. All 1,715 excess buyers were cleanly turned away without a single duplicate reservation.
- **Zero Database Deadlocks:** Exactly 0 database deadlocks or HTTP 500 internal server errors occurred under 20:1 thread contention (Tier 4).
- **Sub-Millisecond Rejections:** In-memory Redis Lua filters fast-fail losing buyers in RAM, protecting database connection pools.
- **Flawless Reconciliation:** PostgreSQL net inventory balances (`on_hand - reserved = available`) reconciled with 100% mathematical precision with zero negative quantities.

---

## Architectural Pillars

```text
                                  [ 100,000+ Flash Sale Shoppers ]
                                                 │
                                                 ▼
┌─────────────────────────────────────────────────────────────────────────────────────────────────┐
│ 1. VIRTUAL WAITING ROOM (Token Bucket / Leaky Bucket Gate)                                     │
│    - Redis Sorted Sets + Monotonic Atomic Ticket Counters (Ticket #1, #2, ...)                  │
│    - Real-time ETA and position tracking ("Ahead in queue: 14", "Now Serving #128")             │
│    - Leaky-bucket rate limiter admits controlled batches (e.g., 50 checkouts/sec)                │
│    - Cryptographic single-use admission tokens (X-Queue-Admission-Token) with TTL               │
└───────────────────────────────────────────────┬─────────────────────────────────────────────────┘
                                                │
                     ┌──────────────────────────┴──────────────────────────┐
                     ▼                                                     ▼
     [ Read-Heavy Traffic: Browsing & Reviews ]            [ Write-Heavy Traffic: Checkout ]
                     │                                                     │
                     ▼                                                     ▼
┌───────────────────────────────────────────────┐ ┌───────────────────────────────────────────────┐
│ 2. CQRS READ-REPLICA POOL                     │ │ 3. PRIMARY WRITE ENGINE                       │
│    - Read-replica connection pool             │ │    - Primary PostgreSQL instance              │
│    - Read-only transaction enforcement        │ │    - SELECT ... FOR UPDATE (ordered locks)    │
│    - Serves catalog, ratings, and analytics   │ │    - Atomic multi-table checkout transactions │
│    - Zero lock contention on primary DB       │ │    - Append-only stock audit ledger           │
└───────────────────────────────────────────────┘ └───────────────────────┬───────────────────────┘
                                                                          │
                                                                          ▼
┌─────────────────────────────────────────────────────────────────────────────────────────────────┐
│ 4. DATE-RANGE TABLE PARTITIONING (PostgreSQL Declarative Range)                                 │
│    - orders and inventory_movements partitioned monthly (e.g. orders_y2026m10)                   │
│    - Query engine automatically prunes historical partitions; only active partition is scanned  │
│    - Drastically smaller B-Tree index memory footprint and low disk I/O under high order volume │
└─────────────────────────────────────────────────────────────────────────────────────────────────┘
```

---

### 1. CQRS & Read Replicas (Command Query Responsibility Segregation)
- **Primary vs. Replica Isolation:** Browsing the catalog, viewing customer feedback summaries, and querying executive analytics are directed to an isolated read-replica pool (`get_read_db`), complete with read-only transaction constraints.
- **Write-Primary Reservation:** The primary PostgreSQL instance (`get_write_db`) is reserved exclusively for checkout transactions, inventory allocations, and payment authorizations.
- **Connection Pool Optimization:** Prevents read traffic from starving database connection pools during flash drops.

### 2. Table Partitioning for High-Volume Orders
- **Declarative Range Partitioning:** Both `orders` and `inventory_movements` are natively partitioned by `created_at` (`PARTITION BY RANGE (created_at)`).
- **Automated Lifecycle Maintenance:** An automated partition supervisor (`ensure_date_partitions()`) dynamically provisions previous, current, and upcoming monthly partition tables (`orders_y2026m08` through `orders_y2027m04`) plus fallback `_default` partitions.
- **Partition Pruning:** When querying flash sales for the active month, PostgreSQL's query optimizer executes isolated scans on the current partition (e.g. `orders_y2026m10`), bypassing all historical data and eliminating sequential scan degradation as order volume grows into millions.

### 3. Queue-Based Virtual Waiting Room (Token Bucket / Leaky Bucket)
- **100,000+ User Traffic Protection:** When incoming traffic spikes beyond database capacity, requests are queued in Redis Sorted Sets (`ZADD`) with monotonic integer tickets.
- **Fair FIFO Queuing:** Shoppers track their numbered position in line, the currently serving counter, and estimated time remaining in the UI.
- **Leaky Bucket Rate Limiting:** A background worker admits buyers at a calibrated rate (e.g., 50 checkouts/second).
- **Single-Use Admission Tokens:** Admitted shoppers receive a cryptographically signed token (`X-Queue-Admission-Token`) required at checkout that is consumed atomically to prevent bypass or replay attacks.

### 4. Automated Restock Waitlist & 10-Minute Hold Expiry Alerts
- **Fast Sell-Out Protection:** When a limited drop sells out in seconds, rejected shoppers can join an automated FIFO restock waitlist.
- **Automated Expiration Reclaim:** During checkout, shoppers are granted a 10-minute hold window. If a hold expires unpurchased, `release_expired_reservations()` reclaims the stock and automatically awakens the next waitlisted shopper in FIFO order.
- **1-Click Reservation Claim:** The notified shopper receives an exclusive claim token with a 10-minute priority claim window and a real-time notification banner in the web interface.

---

## Database Design & Relational Schema

PostgreSQL 16 serves as the primary system of record. All financial amounts are stored as integer cents to eliminate floating-point rounding errors.


<img width="1922" height="3540" alt="SurgeCart Entity Relationship Diagram" src="https://github.com/user-attachments/assets/6524289a-fee8-4e6d-8ff3-3d734de236d3" />

### Relational Tables & Integrity Constraints

| Table | Structure & Strategy | Key Integrity Constraints |
| :--- | :--- | :--- |
| `orders` | **Partitioned Table** (`RANGE (created_at)`) | Composite PK `(id, created_at)`, Unique `order_number`, Status enum (`pending_payment`, `paid`, `cancelled`, `refunded`). |
| `inventory_movements` | **Partitioned Table** (`RANGE (created_at)`) | Composite PK `(id, created_at)`, Check `quantity_delta <> 0`, Unique `idempotency_key` for exactly-once processing. |
| `flash_sale_waitlist` | **FIFO Restock Queue** | Indexed `(product_id, position)`, Status enum (`pending`, `notified`, `claimed`, `expired`), unique `claim_token`. |
| `inventory` | Real-time on-hand & reserved balances | Check `on_hand_quantity >= 0`, Check `reserved_quantity >= 0`, Check `reserved_quantity <= on_hand_quantity`. |
| `inventory_reservations`| 10-minute holding window | Status enum (`active`, `committed`, `released`, `expired`), check constraint ensuring owner is cart or order. |
| `flash_sales` | Campaign scheduling | Check `ends_at > starts_at`, status enumeration (`draft`, `scheduled`, `active`, `ended`, `cancelled`). |
| `flash_sale_products` | Inventory allocations | Unique `(flash_sale_id, product_id)`, Check `allocation_quantity > 0`, Check `per_customer_limit >= 1`. |
| `products` | Core catalog & specs | Unique `sku`, Non-negative `price_cents`, JSONB media gallery and dimensions. |
| `product_feedback` | Verified reviews | Engine Check `1 <= rating_score <= 5`, composite index `(product_id, rating_score)`. |
| `users` | Identity & RBAC | Primary Key UUID, Unique `email`, Argon2 password hashing. |

---

## Concurrency Defense

### Tier 1: In-Memory Redis Lua Stock Shield
Incoming checkouts are filtered in RAM using an atomic Lua script (`fast_reserve_stock`). Because Redis is single-threaded, decrementing stock and validating against zero happens atomically in microseconds:
- **Winning requests** decrement the in-memory counter and proceed to database checkout.
- **Losing requests** fail immediately in RAM, returning HTTP 409 Conflict in sub-millisecond time. Database connection pools are never saturated by losing traffic.

### Tier 2: Deterministic Row-Level Database Locking
Requests that pass Tier 1 enter an atomic PostgreSQL transaction. To mathematically prevent deadlocks:
1. All target cart items are sorted deterministically: `ORDER BY product_id ASC`.
2. Each inventory row is locked in ascending sequence using `SELECT ... FOR UPDATE`.
3. Because all concurrent transactions acquire row locks in the exact same order, cyclic lock dependencies (deadlocks) are mathematically impossible.
4. Stock is verified, allocated, and committed in an ACID transaction with an append-only audit trail in `inventory_movements`.

---

## Technology Stack

| Component | Technology | Rationale |
| :--- | :--- | :--- |
| **API Backend** | FastAPI, Pydantic v2, Python 3.12+ | High-throughput asynchronous I/O, typed validation, OpenAPI generation. |
| **Database** | PostgreSQL 16 | Declarative range partitioning, row-level pessimistic locking (`FOR UPDATE`), check constraints. |
| **In-Memory Tier** | Redis 7 | Microsecond atomic Lua counters, Sorted Set ticket queues, and sliding-window rate limiters. |
| **ORM & Migrations** | SQLAlchemy 2.0, Alembic | Async connection pooling, CQRS read-replica session splitting, automated DDL migrations. |
| **Frontend Web App** | React 19, TypeScript, Vite | Zero framework bloat, fast load times, and custom hooks for real-time queue polling. |
| **Design System** | Vanilla CSS Design Tokens | Editorial layout inspired by modern print typography (`Playfair Display`, `Inter`), zero emojis. |
| **DevOps** | Docker, Docker Compose | Production-parity local orchestration of PostgreSQL 16 and Redis 7. |

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
Verify both containers are running healthy:
```powershell
docker ps
```

### 3. Initialize and Start Backend
```powershell
cd backend
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -e ".[dev]"
alembic upgrade head
python -m app.seed
uvicorn app.main:app --reload --port 8000
```

Seeded Accounts:
- **Administrator:** `admin@surgecart.local` / `change-this-password`
- **Customer:** `customer@surgecart.local` / `change-this-password`

API Documentation:
- Swagger Interactive Docs: `http://localhost:8000/docs`
- Healthcheck: `http://localhost:8000/api/v1/health`
- Cluster Telemetry: `http://localhost:8000/api/v1/system/cluster`

### 4. Start Frontend Storefront & Admin
Open a new terminal:
```powershell
cd frontend
npm install
npm run dev
```
Visit `http://localhost:5173`:
- **Storefront:** Browse catalog drops, view real-time inventory gauges, and join restock waitlists for sold-out items.
- **Admin Console (`http://localhost:5173/#admin`):** Access executive analytics, schedule flash sale drops, configure the Virtual Waiting Room, and inspect monthly partition topology.

---

## Running the Verification & Benchmark Scripts

### 1. Concurrency Benchmark (100 to 1,000 Concurrent Buyers)
```powershell
cd backend
.\.venv\Scripts\python.exe scripts\concurrency_stress_test.py
```
Stages 100, 250, 500, and 1,000 independent buyers and executes simultaneous checkout bursts across an asynchronous barrier, reporting P50/P95/P99 latency, RPS, and database inventory reconciliation.

### 2. Enterprise Scalability & Architecture Showcase
```powershell
cd backend
.\.venv\Scripts\python.exe scripts\architectural_features_demo.py
```
Executes a live test verifying:
1. CQRS read-replica routing vs primary write pool.
2. PostgreSQL partition pruning on `orders_y2026m10` via query plan analysis.
3. Virtual Waiting Room ticket issuance, leaky-bucket drain, and cryptographic token verification.
4. Automated FIFO restock waitlist notification upon 10-minute hold expiry.

### 3. Automated Test Suite
```powershell
cd backend
.\.venv\Scripts\pytest.exe -v
```
Runs 12 comprehensive unit and integration tests covering flash sale limits, race condition handling, CQRS routing, partitioning, and waiting room gates.

---

## Repository Structure

```text
.
├── backend/
│   ├── alembic/              # Versioned database migrations
│   │   └── versions/         # Partitioning, waitlists, reviews, and core schema
│   ├── app/
│   │   ├── api/              # Root API router & cluster health endpoints
│   │   ├── core/             # Redis Lua scripts, security, and configuration
│   │   ├── db/               # CQRS session pools, base models, partitioning engine
│   │   ├── modules/          # Domain-driven modules
│   │   │   ├── carts/        # Cart synchronization and item limits
│   │   │   ├── catalog/      # Products, reviews, analytics
│   │   │   ├── inventory/    # Stock levels, movements, reservation holds
│   │   │   ├── orders/       # High-concurrency checkout and orders
│   │   │   ├── payments/     # Payment confirmation lifecycle
│   │   │   ├── sales/        # Flash sales and product allocations
│   │   │   ├── users/        # User accounts, Argon2 hashing, JWT
│   │   │   ├── waiting_room/ # In-memory ticket queue and leaky-bucket limiter
│   │   │   └── waitlist/     # Automated FIFO restock waitlist & alert engine
│   │   └── seed.py           # Database seeder
│   ├── scripts/              # High-concurrency stress tests and showcase utilities
│   └── tests/                # Automated pytest test suite
├── frontend/
│   ├── src/
│   │   ├── main.tsx                  # Storefront, PDP, and Admin workspace
│   │   ├── ScalingArchitectureTab.tsx# Admin monitoring for CQRS, partitions, waiting room
│   │   ├── WaitingRoomModal.tsx      # Customer queue ticket dialog with live ETA
│   │   ├── RestockWaitlistModal.tsx  # Customer restock waitlist dialog for sold-out items
│   │   └── styles.css                # Editorial typography and component styles
│   └── index.html
├── docs/                     # Architecture documentation and database schemas
├── docker-compose.yml        # PostgreSQL 16 and Redis 7 definitions
└── README.md
```

---

## Technical Summary

| Engineering Dimension | Implementation in SurgeCart |
| :--- | :--- |
| **Transaction Isolation & ACID** | Single multi-table atomic transaction for checkout with pessimistic row locks (`SELECT ... FOR UPDATE`) in ascending ID order to mathematically eliminate cyclic deadlocks. |
| **Distributed Cache Design** | In-memory atomic Redis Lua scripts (`fast_reserve_stock`) filtering burst traffic in RAM in sub-millisecond execution time, shielding relational database connection pools. |
| **Database Scalability (CQRS)** | Complete separation of read and write database sessions. Browsing and analytics route to read-replica pools with read-only transaction constraints; the write primary handles state mutation exclusively. |
| **Database Scalability (Partitioning)**| PostgreSQL declarative range partitioning by date (`orders` & `inventory_movements`), shrinking active index footprints and eliminating full-table scans. |
| **Traffic Shaping & Throttling** | Queue-based Virtual Waiting Room using Redis Sorted Sets and a Leaky Bucket admission algorithm to regulate 100,000+ shopper spikes. |
| **Event-Driven Inventory Reclaim** | Automatic reclamation of expired 10-minute reservation holds hooked directly into an automated FIFO restock waitlist with exclusive claim tokens. |
| **Auditability & Financial Ledger** | Append-only movement records with unique idempotency keys preventing double-spending and providing an audit trail for financial reconciliation. |
