"""
Catalog Router
==============
Public endpoints:
  GET /api/v1/products        – list all active products, enriched with any
                                 currently-live flash sale assignment so the
                                 frontend can render per-product countdown timers
                                 and discounted prices without a separate round-trip.

Flash sale enrichment (requirement §3):
  For each product returned, if it belongs to an active flash sale (status=LIVE,
  window includes current UTC time), the response includes:
    flash_sale_id, sale_price_cents, allocation_quantity, per_customer_limit,
    sale_ends_at, sale_starts_at.
  Otherwise those fields are omitted / null.
"""
from __future__ import annotations

from datetime import UTC, datetime
from typing import Any
from uuid import UUID

from fastapi import APIRouter, Depends
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.db.session import get_db
from app.modules.catalog.models import Product
from app.modules.inventory.models import Inventory, InventoryReservation, ReservationStatus
from app.modules.sales.models import FlashSale, FlashSaleProduct, FlashSaleStatus
from sqlalchemy import func, select

router = APIRouter(prefix="/products", tags=["products"])


@router.get("")
def list_active_products(db: Session = Depends(get_db)) -> list[dict[str, Any]]:
    """
    Return every active product together with:
    - current inventory (on_hand, reserved, available)
    - live flash sale context if the product is part of one right now

    The flash sale context lets the storefront render per-product countdown
    timers, urgency badges, and discounted prices without additional API calls.
    """
    now = datetime.now(UTC)

    # ── 1. Fetch all active products ──────────────────────────────────────
    products = list(
        db.scalars(
            select(Product).where(Product.is_active.is_(True)).order_by(Product.name)
        )
    )
    if not products:
        return []

    product_ids = [p.id for p in products]

    # ── 2. Fetch inventory snapshot for all products ──────────────────────
    inventory_map: dict[UUID, Inventory] = {
        row.product_id: row
        for row in db.scalars(
            select(Inventory).where(Inventory.product_id.in_(product_ids))
        )
    }

    # ── 3. Fetch live flash sale assignments for these products ───────────
    # A "live" assignment requires the parent FlashSale to be LIVE status
    # and the current time to be inside the [starts_at, ends_at) window.
    live_fsp_rows = list(
        db.scalars(
            select(FlashSaleProduct)
            .join(FlashSale, FlashSale.id == FlashSaleProduct.flash_sale_id)
            .where(
                FlashSaleProduct.product_id.in_(product_ids),
                FlashSale.status == FlashSaleStatus.LIVE,
                FlashSale.starts_at <= now,
                FlashSale.ends_at > now,
            )
        )
    )

    # Build product_id → (fsp, sale) lookup; last-write wins for edge cases
    # where a product somehow ended up in two non-overlapping sales that are
    # both LIVE (shouldn't happen after the overlap guard is applied).
    flash_context: dict[UUID, dict[str, Any]] = {}
    if live_fsp_rows:
        fsp_sale_ids = [fsp.flash_sale_id for fsp in live_fsp_rows]
        sale_map: dict[UUID, FlashSale] = {
            s.id: s
            for s in db.scalars(
                select(FlashSale).where(FlashSale.id.in_(fsp_sale_ids))
            )
        }

        # Aggregate committed & active reservations for these live flash sales
        committed_rows = db.execute(
            select(
                InventoryReservation.flash_sale_id,
                InventoryReservation.product_id,
                func.coalesce(func.sum(InventoryReservation.quantity), 0).label("units"),
            )
            .where(
                InventoryReservation.flash_sale_id.in_(fsp_sale_ids),
                InventoryReservation.status.in_(
                    [ReservationStatus.COMMITTED, ReservationStatus.ACTIVE]
                ),
            )
            .group_by(
                InventoryReservation.flash_sale_id, InventoryReservation.product_id
            )
        ).all()
        committed_map: dict[tuple[UUID, UUID], int] = {
            (row.flash_sale_id, row.product_id): int(row.units)
            for row in committed_rows
        }

        for fsp in live_fsp_rows:
            sale = sale_map.get(fsp.flash_sale_id)
            if sale:
                units_sold = committed_map.get((fsp.flash_sale_id, fsp.product_id), 0)
                units_remaining = max(0, fsp.allocation_quantity - units_sold)
                flash_context[fsp.product_id] = {
                    "flash_sale_id": str(fsp.flash_sale_id),
                    "flash_sale_product_id": str(fsp.id),
                    "flash_sale_name": sale.name,
                    "sale_price_cents": fsp.sale_price_cents,
                    "allocation_quantity": fsp.allocation_quantity,
                    "units_sold": units_sold,
                    "units_remaining": units_remaining,
                    "per_customer_limit": fsp.per_customer_limit,
                    "sale_starts_at": sale.starts_at.isoformat(),
                    "sale_ends_at": sale.ends_at.isoformat(),
                }

    # ── 4. Assemble response ──────────────────────────────────────────────
    result: list[dict[str, Any]] = []
    for product in products:
        inv = inventory_map.get(product.id)
        on_hand = inv.on_hand_quantity if inv else 0
        reserved = inv.reserved_quantity if inv else 0
        available = max(0, on_hand - reserved)

        row: dict[str, Any] = {
            "id": str(product.id),
            "sku": product.sku,
            "name": product.name,
            "description": product.description,
            "price_cents": product.price_cents,
            "currency": product.currency,
            "on_hand_quantity": on_hand,
            "available_quantity": available,
            # Flash sale context – present only when product is in a live sale
            "flash_sale": flash_context.get(product.id),  # None → omitted by FE
        }
        result.append(row)

    return result
