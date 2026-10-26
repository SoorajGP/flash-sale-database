"""
Admin Analytics Router
=======================
Provides the single analytics endpoint required by requirement §2.2:

  GET /api/v1/admin/analytics

Response shape:
  {
    "total_revenue_cents": int,
    "total_orders": int,
    "top_products": [
      { "product_id", "product_name", "product_sku",
        "units_sold", "revenue_cents", "order_count" }, ...
    ],
    "flash_sale_velocity": [
      { "flash_sale_id", "flash_sale_name", "product_id", "product_name",
        "allocation_quantity", "units_sold", "units_remaining",
        "sell_through_pct", "velocity_units_per_hour",
        "sale_starts_at", "sale_ends_at", "is_live" }, ...
    ]
  }

Sell-out velocity formula:
  velocity = units_sold / hours_elapsed_since_sale_start
  hours_elapsed = max(1/60, (now - starts_at).total_seconds() / 3600)

Complexity is kept O(1) in the number of queries by using GROUP BY aggregations.
"""
from __future__ import annotations

from datetime import UTC, datetime, timedelta
from typing import Annotated, Any
from uuid import UUID

from fastapi import APIRouter, Depends
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.core.security import require_admin
from app.db.session import get_db
from app.modules.inventory.models import InventoryReservation, ReservationStatus
from app.modules.orders.models import Order, OrderItem, OrderStatus
from app.modules.sales.models import FlashSale, FlashSaleProduct, FlashSaleStatus
from app.modules.users.models import User

router = APIRouter(prefix="/admin", tags=["admin"])


@router.get("/analytics")
def get_analytics(
    _: Annotated[User, Depends(require_admin)],
    db: Annotated[Session, Depends(get_db)],
) -> dict[str, Any]:
    """
    Aggregated analytics for the admin dashboard.

    Queries
    -------
    1. Total revenue: SUM of line_total_cents for PAID orders.
    2. Top products: GROUP BY product on order_items for PAID orders, sorted by
       units_sold DESC, limited to 10.
    3. Flash sale velocity: for every active or recently-ended sale, compute
       units committed vs allocation, then derive velocity (units/hour).
    """
    now = datetime.now(UTC)

    # ── 1. Total revenue & order count (PAID orders only) ─────────────────
    paid_statuses = [OrderStatus.PAID, OrderStatus.FULFILLED]

    revenue_row = db.execute(
        select(
            func.coalesce(func.sum(OrderItem.line_total_cents), 0).label("revenue"),
            func.count(func.distinct(Order.id)).label("order_count"),
        )
        .join(Order, Order.id == OrderItem.order_id)
        .where(Order.status.in_(paid_statuses))
    ).one()

    total_revenue_cents: int = revenue_row.revenue
    total_orders: int = revenue_row.order_count

    # ── 2. Top-selling products (top 10 by units sold, paid orders) ───────
    top_rows = db.execute(
        select(
            OrderItem.product_id,
            OrderItem.product_name,
            OrderItem.product_sku,
            func.sum(OrderItem.quantity).label("units_sold"),
            func.sum(OrderItem.line_total_cents).label("revenue_cents"),
            func.count(func.distinct(Order.id)).label("order_count"),
        )
        .join(Order, Order.id == OrderItem.order_id)
        .where(Order.status.in_(paid_statuses))
        .group_by(OrderItem.product_id, OrderItem.product_name, OrderItem.product_sku)
        .order_by(func.sum(OrderItem.quantity).desc())
        .limit(10)
    ).all()

    top_products = [
        {
            "product_id": str(row.product_id),
            "product_name": row.product_name,
            "product_sku": row.product_sku,
            "units_sold": int(row.units_sold),
            "revenue_cents": int(row.revenue_cents),
            "order_count": int(row.order_count),
        }
        for row in top_rows
    ]

    # ── 3. Flash sale velocity (live + ended-within-24h sales) ───────────
    # Load sales: currently live OR ended in the last 24 h for recency context
    recent_cutoff = now - timedelta(hours=24)
    sales = list(
        db.scalars(
            select(FlashSale).where(
                (
                    (FlashSale.status == FlashSaleStatus.LIVE)
                    | (
                        (FlashSale.status == FlashSaleStatus.ENDED)
                        & (FlashSale.ends_at >= recent_cutoff)
                    )
                )
            )
        )
    )

    velocity_data: list[dict[str, Any]] = []
    if sales:
        sale_ids = [s.id for s in sales]
        sale_map: dict[UUID, FlashSale] = {s.id: s for s in sales}

        # Load all FlashSaleProduct rows for those sales
        fsp_rows = list(
            db.scalars(
                select(FlashSaleProduct).where(
                    FlashSaleProduct.flash_sale_id.in_(sale_ids)
                )
            )
        )

        # Aggregate committed units per (flash_sale_id, product_id)
        committed_rows = db.execute(
            select(
                InventoryReservation.flash_sale_id,
                InventoryReservation.product_id,
                func.coalesce(func.sum(InventoryReservation.quantity), 0).label("units"),
            )
            .where(
                InventoryReservation.flash_sale_id.in_(sale_ids),
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

        for fsp in fsp_rows:
            sale = sale_map[fsp.flash_sale_id]
            units_sold = committed_map.get((fsp.flash_sale_id, fsp.product_id), 0)
            units_remaining = max(0, fsp.allocation_quantity - units_sold)
            sell_through_pct = (
                round(units_sold / fsp.allocation_quantity * 100, 1)
                if fsp.allocation_quantity > 0
                else 0.0
            )

            # Velocity = units sold per hour since sale started
            sale_start = sale.starts_at
            if sale_start.tzinfo is None:
                sale_start = sale_start.replace(tzinfo=UTC)
            elapsed_seconds = max(60, (now - sale_start).total_seconds())
            elapsed_hours = elapsed_seconds / 3600
            velocity_units_per_hour = round(units_sold / elapsed_hours, 2)

            is_live = (
                sale.status == FlashSaleStatus.LIVE
                and sale.starts_at <= now < sale.ends_at
            )

            velocity_data.append(
                {
                    "flash_sale_id": str(fsp.flash_sale_id),
                    "flash_sale_name": sale.name,
                    "product_id": str(fsp.product_id),
                    "allocation_quantity": fsp.allocation_quantity,
                    "units_sold": units_sold,
                    "units_remaining": units_remaining,
                    "sell_through_pct": sell_through_pct,
                    "velocity_units_per_hour": velocity_units_per_hour,
                    "sale_starts_at": sale.starts_at.isoformat(),
                    "sale_ends_at": sale.ends_at.isoformat(),
                    "is_live": is_live,
                }
            )

        # Sort by velocity descending
        velocity_data.sort(key=lambda x: x["velocity_units_per_hour"], reverse=True)

    return {
        "total_revenue_cents": total_revenue_cents,
        "total_orders": total_orders,
        "top_products": top_products,
        "flash_sale_velocity": velocity_data,
    }
