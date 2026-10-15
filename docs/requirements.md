# SurgeCart — milestone 1 requirements

## Product goal

SurgeCart sells limited inventory during time-bounded flash sales. It must prevent overselling while allowing fast guest and signed-in shopping flows.

## In scope

- A React + TypeScript + Vite web client and FastAPI service in one deployable modular monolith.
- PostgreSQL as the system of record.
- Versioned database migration for catalog, inventory, flash sale, cart, order, order item, and reservation records.
- A health endpoint and starter product listing endpoint.
- Explicit data/invariant documentation for a later checkout implementation.

## Domain rules captured by the schema

1. Product SKU is globally unique. Prices are integer minor currency units, never floating point.
2. Each product has one inventory balance row. `reserved_quantity` cannot exceed `on_hand_quantity`.
3. Inventory movements form an append-only audit trail; an idempotency key can be used once.
4. A flash sale has distinct scheduling and publication state. A product can occur once per flash sale.
5. A cart can represent either a guest session or a customer, and its items are unique per product.
6. An order stores immutable item title, SKU, and unit-price snapshots.
7. A reservation holds a positive quantity only until its expiry and associates with a cart or an order.

## Deliberately deferred

- Addresses, live payment-provider capture, tax, shipment, refunds, and promotions beyond the sale price.
- Background expiry worker and payment-provider webhook handling.
- Public CRUD APIs and an operational admin UI.
- Metrics, tracing, rate limiting, and deployment automation.
