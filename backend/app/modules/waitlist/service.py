"""
Automated Waitlist & Restock Alert Service
==========================================
Enables rejected flash sale shoppers (e.g., when a sale sells out in 30 seconds)
to join an automated waitlist that notifies them immediately when 10-minute
reservation holds expire unpurchased.
"""
from __future__ import annotations

from datetime import UTC, datetime, timedelta
import logging
import secrets
from typing import Any
from uuid import UUID

from sqlalchemy import func, or_, select
from sqlalchemy.orm import Session

from app.core.config import get_settings
from app.core.redis import get_redis_client
from app.modules.catalog.models import Product
from app.modules.sales.models import FlashSale
from app.modules.waitlist.models import FlashSaleWaitlist, WaitlistStatus

logger = logging.getLogger("surgecart.waitlist")


def join_waitlist(
    db: Session,
    product_id: UUID,
    flash_sale_id: UUID | None = None,
    user_id: UUID | None = None,
    email: str | None = None,
) -> dict[str, Any]:
    """Adds a customer to the restock waitlist and assigns an atomic FIFO position."""
    # Check if product exists
    product = db.get(Product, product_id)
    if not product:
        raise ValueError("Product not found")

    # Check for existing active waitlist entry for this user/email & product
    existing_q = select(FlashSaleWaitlist).where(
        FlashSaleWaitlist.product_id == product_id,
        FlashSaleWaitlist.status.in_([WaitlistStatus.PENDING, WaitlistStatus.NOTIFIED]),
    )
    if user_id:
        existing_q = existing_q.where(FlashSaleWaitlist.user_id == user_id)
    elif email:
        existing_q = existing_q.where(FlashSaleWaitlist.email == email)
    else:
        existing_q = existing_q.where(False)

    existing = db.scalar(existing_q)
    if existing:
        return {
            "waitlist_id": str(existing.id),
            "product_id": str(existing.product_id),
            "product_name": product.name,
            "position": existing.position,
            "status": existing.status.value,
            "notified_at": existing.notified_at.isoformat() if existing.notified_at else None,
            "claim_expires_at": existing.claim_expires_at.isoformat() if existing.claim_expires_at else None,
            "already_joined": True,
        }

    # Calculate next queue position
    max_pos = db.scalar(
        select(func.coalesce(func.max(FlashSaleWaitlist.position), 0)).where(
            FlashSaleWaitlist.product_id == product_id
        )
    ) or 0
    next_position = max_pos + 1

    entry = FlashSaleWaitlist(
        product_id=product_id,
        flash_sale_id=flash_sale_id,
        user_id=user_id,
        email=email,
        status=WaitlistStatus.PENDING,
        position=next_position,
    )
    db.add(entry)
    db.commit()
    db.refresh(entry)

    logger.info("Shopper joined waitlist for product %s at position #%d", product.name, next_position)

    return {
        "waitlist_id": str(entry.id),
        "product_id": str(entry.product_id),
        "product_name": product.name,
        "position": entry.position,
        "status": entry.status.value,
        "notified_at": None,
        "claim_expires_at": None,
        "already_joined": False,
    }


def process_restock_alerts_for_product(db: Session, product_id: UUID, freed_units: int) -> int:
    """
    Called whenever expired reservation holds are released.
    Finds the top `freed_units` pending waitlist entries in FIFO order,
    advances them to NOTIFIED, generates exclusive claim tokens, and sets a 10-minute claim window.
    """
    if freed_units <= 0:
        return 0

    now = datetime.now(UTC)
    claim_window_mins = get_settings().waitlist_claim_window_minutes
    expires_at = now + timedelta(minutes=claim_window_mins)

    # Fetch top pending entries in order of position and creation
    pending_entries = list(
        db.scalars(
            select(FlashSaleWaitlist)
            .where(
                FlashSaleWaitlist.product_id == product_id,
                FlashSaleWaitlist.status == WaitlistStatus.PENDING,
            )
            .order_by(FlashSaleWaitlist.position.asc(), FlashSaleWaitlist.created_at.asc())
            .limit(freed_units)
            .with_for_update()
        )
    )

    if not pending_entries:
        return 0

    notified_count = 0
    product = db.get(Product, product_id)
    product_name = product.name if product else "Item"

    for entry in pending_entries:
        claim_token = f"claim_{secrets.token_urlsafe(32)}"
        entry.status = WaitlistStatus.NOTIFIED
        entry.notified_at = now
        entry.claim_expires_at = expires_at
        entry.claim_token = claim_token
        notified_count += 1

        logger.info(
            "RESTOCK ALERT: User %s (Waitlist #%d) notified for restocked %s. Claim window active until %s.",
            entry.user_id or entry.email,
            entry.position,
            product_name,
            expires_at.isoformat(),
        )

        # Broadcast via Redis PubSub if available
        client = get_redis_client()
        if client:
            try:
                alert_payload = {
                    "event": "restock_alert",
                    "waitlist_id": str(entry.id),
                    "product_id": str(product_id),
                    "product_name": product_name,
                    "claim_token": claim_token,
                    "claim_expires_at": expires_at.isoformat(),
                    "email": entry.email,
                    "user_id": str(entry.user_id) if entry.user_id else None,
                }
                client.publish("surgecart:restock_alerts", str(alert_payload))
            except Exception as e:
                logger.debug("Could not publish restock alert to Redis: %s", e)

    db.commit()
    return notified_count


def get_user_restock_alerts(
    db: Session,
    user_id: UUID | None = None,
    email: str | None = None,
) -> list[dict[str, Any]]:
    """Returns active restock notifications where the 10-minute hold claim window is currently open."""
    now = datetime.now(UTC)
    q = (
        select(FlashSaleWaitlist, Product)
        .join(Product, Product.id == FlashSaleWaitlist.product_id)
        .where(
            FlashSaleWaitlist.status == WaitlistStatus.NOTIFIED,
            FlashSaleWaitlist.claim_expires_at > now,
        )
    )

    if user_id and email:
        q = q.where(or_(FlashSaleWaitlist.user_id == user_id, FlashSaleWaitlist.email == email))
    elif user_id:
        q = q.where(FlashSaleWaitlist.user_id == user_id)
    elif email:
        q = q.where(FlashSaleWaitlist.email == email)
    else:
        return []

    rows = db.execute(q).all()
    results: list[dict[str, Any]] = []
    for waitlist_item, prod in rows:
        exp = waitlist_item.claim_expires_at
        if exp and exp.tzinfo is None:
            exp = exp.replace(tzinfo=UTC)
        results.append(
            {
                "waitlist_id": str(waitlist_item.id),
                "product_id": str(prod.id),
                "product_name": prod.name,
                "product_sku": prod.sku,
                "price_cents": prod.price_cents,
                "claim_token": waitlist_item.claim_token,
                "claim_expires_at": waitlist_item.claim_expires_at.isoformat() if waitlist_item.claim_expires_at else None,
                "remaining_seconds": max(0, int((exp - now).total_seconds())) if exp else 0,
            }
        )
    return results


def claim_waitlist_stock(db: Session, claim_token: str) -> dict[str, Any]:
    """Validates an exclusive restock claim token and marks it CLAIMED."""
    now = datetime.now(UTC)
    entry = db.scalar(
        select(FlashSaleWaitlist)
        .where(
            FlashSaleWaitlist.claim_token == claim_token,
            FlashSaleWaitlist.status == WaitlistStatus.NOTIFIED,
        )
        .with_for_update()
    )
    if not entry:
        raise ValueError("Invalid or non-existent claim token")

    entry_exp = entry.claim_expires_at
    if entry_exp and entry_exp.tzinfo is None:
        entry_exp = entry_exp.replace(tzinfo=UTC)
    if entry_exp and entry_exp < now:
        entry.status = WaitlistStatus.EXPIRED
        db.commit()
        raise ValueError("The 10-minute restock claim window has expired")

    entry.status = WaitlistStatus.CLAIMED
    product = db.get(Product, entry.product_id)
    db.commit()

    return {
        "status": "claimed",
        "product_id": str(entry.product_id),
        "product_name": product.name if product else "",
        "message": "Stock hold claimed successfully. Proceed to checkout.",
    }


def get_waitlist_telemetry(db: Session, product_id: UUID) -> dict[str, Any]:
    """Returns aggregated waitlist statistics for product."""
    total_waiting = db.scalar(
        select(func.count(FlashSaleWaitlist.id)).where(
            FlashSaleWaitlist.product_id == product_id,
            FlashSaleWaitlist.status == WaitlistStatus.PENDING,
        )
    ) or 0
    total_notified = db.scalar(
        select(func.count(FlashSaleWaitlist.id)).where(
            FlashSaleWaitlist.product_id == product_id,
            FlashSaleWaitlist.status == WaitlistStatus.NOTIFIED,
        )
    ) or 0
    total_claimed = db.scalar(
        select(func.count(FlashSaleWaitlist.id)).where(
            FlashSaleWaitlist.product_id == product_id,
            FlashSaleWaitlist.status == WaitlistStatus.CLAIMED,
        )
    ) or 0

    return {
        "product_id": str(product_id),
        "pending_waitlist_count": total_waiting,
        "notified_count": total_notified,
        "claimed_count": total_claimed,
    }
