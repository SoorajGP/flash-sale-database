from __future__ import annotations

from collections import defaultdict
from datetime import UTC, datetime
import logging
from uuid import UUID

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.redis import fast_release_stock, set_product_stock_cache
from app.modules.inventory.models import (
    Inventory,
    InventoryMovement,
    InventoryMovementType,
    InventoryReservation,
    ReservationStatus,
)

logger = logging.getLogger(__name__)


def release_expired_reservations(db: Session) -> int:
    """
    Finds and releases all active inventory holds that have exceeded their expiry window.
    Decreases reserved_quantity, updates reservation status to EXPIRED, records movement,
    notifies automated waitlist subscribers of restocked inventory, and returns released count.
    """
    now = datetime.now(UTC)
    expired_reservations = list(
        db.scalars(
            select(InventoryReservation)
            .where(
                InventoryReservation.status == ReservationStatus.ACTIVE,
                InventoryReservation.expires_at < now,
            )
            .with_for_update()
        )
    )

    if not expired_reservations:
        return 0

    # Sort product IDs deterministically to eliminate any potential deadlock
    product_ids = sorted(list({r.product_id for r in expired_reservations}))
    inventory_rows = {
        row.product_id: row
        for row in db.scalars(
            select(Inventory)
            .where(Inventory.product_id.in_(product_ids))
            .order_by(Inventory.product_id)
            .with_for_update()
        )
    }

    freed_by_product: dict[UUID, int] = defaultdict(int)
    released_count = 0
    for res in expired_reservations:
        inventory = inventory_rows.get(res.product_id)
        if inventory:
            inventory.reserved_quantity = max(0, inventory.reserved_quantity - res.quantity)
            res.status = ReservationStatus.EXPIRED
            db.add(
                InventoryMovement(
                    product_id=res.product_id,
                    movement_type=InventoryMovementType.RELEASE,
                    quantity_delta=res.quantity,
                    reference_type="order",
                    reference_id=res.order_id,
                    idempotency_key=f"expire_release:{res.id}",
                )
            )
            fast_release_stock(str(res.product_id), res.quantity)
            released_count += 1
            freed_by_product[res.product_id] += res.quantity
        else:
            res.status = ReservationStatus.EXPIRED
            released_count += 1
            freed_by_product[res.product_id] += res.quantity

    db.commit()
    logger.info("Released %d expired inventory reservations", released_count)

    # Automated Restock Alerts: Notify waitlisted shoppers of freed units
    for product_id, freed_qty in freed_by_product.items():
        try:
            from app.modules.waitlist.service import process_restock_alerts_for_product

            notified = process_restock_alerts_for_product(db, product_id, freed_qty)
            if notified > 0:
                logger.info(
                    "Automated Restock: Triggered %d priority alerts for product %s from expired 10-minute holds.",
                    notified,
                    product_id,
                )
        except Exception as e:
            logger.warning("Error processing restock alerts for product %s: %s", product_id, e)

    return released_count


def warm_inventory_cache(db: Session) -> None:
    """Warms Redis with current available quantities."""
    inventory_rows = db.scalars(select(Inventory)).all()
    for row in inventory_rows:
        available = max(0, row.on_hand_quantity - row.reserved_quantity)
        set_product_stock_cache(str(row.product_id), available)
