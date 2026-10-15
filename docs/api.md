# API map

All endpoints begin with `/api/v1`; FastAPI exposes an interactive version at `/docs`.

| Area | Endpoints | Notes |
| --- | --- | --- |
| Health | `GET /health` | Deployment check. |
| Auth | `POST /auth/register`, `POST /auth/login`, `GET /auth/me` | Login returns a bearer token. |
| Catalogue | `GET /products`, `GET /flash-sales` | Storefront reads. |
| Cart | `POST /carts`, `GET /carts/{id}`, `POST /carts/{id}/items` | Guest carts use an opaque session identifier. |
| Checkout | `POST /orders/checkout/{cart_id}`, `POST /orders/{id}/pay` | Reserves stock then runs **demo-only** payment completion. |
| Admin | `GET /admin/dashboard`, `POST /admin/products`, `POST /admin/products/{id}/restock` | Requires an admin bearer token. |
| Sale administration | `POST /admin/flash-sales`, `POST /admin/flash-sales/{id}/products` | Requires an admin bearer token. |

## Admin authentication

After running `python -m app.seed`, sign in with `admin@surgecart.local` / `change-this-password` and copy the returned `access_token` into the **Authorize** dialog in `/docs` as a bearer token. Change the seed password immediately in any non-local environment.

## Payment boundary

`POST /orders/{id}/pay` is only a local demo adapter: it immediately marks a pending payment as paid. It must not be exposed publicly in production. The production replacement is a provider adapter that creates a Stripe Payment Intent/Checkout Session and a verified Stripe webhook handler that makes the same transactional state change.
