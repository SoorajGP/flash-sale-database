# Database guide

## Why PostgreSQL

Flash-sale checkout is a concurrency problem. PostgreSQL gives SurgeCart row locks, transactional writes, constraints, and a durable audit trail without introducing a separate inventory service.

## Relationships

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

## Tables at a glance

| Table | Why it exists | Important rule |
| --- | --- | --- |
| `users` | Customer and administrator identity | Email is unique; role is `customer` or `admin`. |
| `products` | The stable catalogue record | SKU is unique; money is stored as integer cents. |
| `inventory` | Current stock balance | One row per product; `0 ≤ reserved ≤ on_hand`. |
| `inventory_movements` | Immutable operational audit | Each request has a unique idempotency key. |
| `flash_sales` | The time window and publication status | End must be later than start. |
| `flash_sale_products` | A product's sale-specific price and allocation | A product appears once per sale. |
| `carts`, `cart_items` | Shopper intent before purchase | Guest session or user must be present; no duplicate product lines. |
| `orders`, `order_items` | Purchase records | Item name/SKU/price are snapshots, not references to mutable catalogue values. |
| `payments` | Payment-provider state | One payment record per order in this MVP. |
| `inventory_reservations` | Short payment hold | Positive quantity with a mandatory expiry and cart/order owner. |

## Checkout sequence

1. Lock affected `inventory` rows (`FOR UPDATE`).
2. Reject when available stock (`on_hand - reserved`) is insufficient.
3. Create `orders`, `order_items`, `payments`, and active `inventory_reservations`; increase `reserved_quantity`.
4. On verified payment, lock the reservation and inventory rows, reduce both `on_hand_quantity` and `reserved_quantity`, then mark the reservation and payment as committed/paid.
5. A future expiry worker will release expired reservations by reducing `reserved_quantity` and writing a release movement.

The starter implements steps 1–4. `POST /api/v1/orders/{order_id}/pay` is intentionally a **demo payment** endpoint. A real deployment must replace it with a payment-provider webhook that verifies signatures before changing stock or order status.
