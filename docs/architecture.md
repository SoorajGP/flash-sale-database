# SurgeCart architecture

## Shape

SurgeCart is a **modular monolith**: one FastAPI process, one PostgreSQL database, and a Vite-served React client during development. Modules own their models and service logic but share a database transaction boundary.

```text
React + Vite
     |
 FastAPI API layer
     |
 catalog | inventory | sales | carts | orders
     |                 |
     +---- SQLAlchemy + Alembic ----+
                                  PostgreSQL
```

The API is organized by business module under `backend/app/modules/`; `app/db` contains only shared database wiring and model registration. Avoid a generic catch-all "models" or "services" package as functionality grows.

## Core records

| Module | Records | Responsibility |
| --- | --- | --- |
| Catalog | `products` | Sellable product identity and regular price |
| Inventory | `inventory`, `inventory_movements`, `inventory_reservations` | Availability and its audit trail |
| Sales | `flash_sales`, `flash_sale_products` | Timed sale rules and sale price/allocation |
| Carts | `carts`, `cart_items` | Mutable shopper intent |
| Orders | `orders`, `order_items` | Durable checkout snapshots and fulfilment state |
| Payments | `payments` | Provider reference and the payment lifecycle |
| Users | `users` | Password-authenticated customer/admin identity |

## Availability and concurrency

The initial migration documents the necessary state, but it intentionally does not add a trigger that silently mutates quantities. The checkout/reservation service must make these changes in one PostgreSQL transaction:

1. Lock the affected `inventory` row with `SELECT ... FOR UPDATE`.
2. Confirm `on_hand_quantity - reserved_quantity >= requested_quantity` and, when applicable, the flash-sale allocation has capacity.
3. Increment `reserved_quantity`, insert an active reservation, and append an inventory movement using a caller-supplied idempotency key.
4. At checkout, convert the reservation to committed, decrement `on_hand_quantity` and `reserved_quantity`, append a movement, and create the order/item snapshots.
5. On expiry or cancellation, reduce `reserved_quantity`, mark the reservation released, and append a release movement.

The public availability calculation is `on_hand_quantity - reserved_quantity`. Never derive it by summing the movement table in request paths; movements remain the audit trail.

## Boundary conventions

- API handlers validate transport input and call a module service; they do not coordinate multi-table writes themselves.
- Services own transactions and idempotency behavior.
- SQLAlchemy models describe persistence only; response schemas should be separate Pydantic models once public endpoints expand.
- Alembic migrations are immutable after deployment. New changes get a new revision.
