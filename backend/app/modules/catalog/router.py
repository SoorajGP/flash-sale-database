"""
Catalog & Product Social Proof Router
=====================================
Public and authenticated endpoints:
  GET  /api/v1/products                   – list active products with stock & flash sale context
  GET  /api/v1/products/{sku_or_id}       – get single product by UUID or SKU with full details
  POST /api/v1/products/{id}/feedback     – authenticated verified review submission
  GET  /api/v1/products/{id}/feedback     – public paginated customer feedback list
  GET  /api/v1/products/{id}/feedback/summary – aggregate quantitative analytics (mean, distribution)
"""
from __future__ import annotations

from datetime import UTC, datetime
from typing import Annotated, Any
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel, Field
from sqlalchemy import func, or_, select
from sqlalchemy.orm import Session

from app.core.security import get_current_user
from app.db.session import get_db
from app.modules.catalog.models import Product, ProductFeedback
from app.modules.inventory.models import Inventory, InventoryReservation, ReservationStatus
from app.modules.sales.models import FlashSale, FlashSaleProduct, FlashSaleStatus
from app.modules.users.models import User

router = APIRouter(prefix="/products", tags=["products"])


class FeedbackCreate(BaseModel):
    rating_score: int = Field(ge=1, le=5, description="Star rating between 1 and 5")
    headline: str = Field(min_length=1, max_length=255, description="Brief summary headline")
    body_text: str = Field(min_length=1, description="Comprehensive feedback narrative")


def _get_live_flash_context(db: Session, product_ids: list[UUID], now: datetime) -> dict[UUID, dict[str, Any]]:
    """Helper to return flash sale context for a batch of product IDs."""
    if not product_ids:
        return {}

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
    if not live_fsp_rows:
        return {}

    fsp_sale_ids = [fsp.flash_sale_id for fsp in live_fsp_rows]
    sale_map: dict[UUID, FlashSale] = {
        s.id: s
        for s in db.scalars(select(FlashSale).where(FlashSale.id.in_(fsp_sale_ids)))
    }

    committed_rows = db.execute(
        select(
            InventoryReservation.flash_sale_id,
            InventoryReservation.product_id,
            func.coalesce(func.sum(InventoryReservation.quantity), 0).label("units"),
        )
        .where(
            InventoryReservation.flash_sale_id.in_(fsp_sale_ids),
            InventoryReservation.status.in_([ReservationStatus.COMMITTED, ReservationStatus.ACTIVE]),
        )
        .group_by(InventoryReservation.flash_sale_id, InventoryReservation.product_id)
    ).all()

    committed_map: dict[tuple[UUID, UUID], int] = {
        (row.flash_sale_id, row.product_id): int(row.units) for row in committed_rows
    }

    flash_context: dict[UUID, dict[str, Any]] = {}
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
    return flash_context


@router.get("")
def list_active_products(db: Session = Depends(get_db)) -> list[dict[str, Any]]:
    """Return active products enriched with inventory and live flash sale parameters."""
    now = datetime.now(UTC)
    products = list(
        db.scalars(
            select(Product).where(Product.is_active.is_(True)).order_by(Product.name)
        )
    )
    if not products:
        return []

    product_ids = [p.id for p in products]

    inventory_map: dict[UUID, Inventory] = {
        row.product_id: row
        for row in db.scalars(
            select(Inventory).where(Inventory.product_id.in_(product_ids))
        )
    }

    flash_context = _get_live_flash_context(db, product_ids, now)

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
            "vendor_id": product.vendor_id,
            "vendor_name": product.vendor_name,
            "category_path": product.category_path,
            "dimensions": product.dimensions,
            "weight": product.weight,
            "media_gallery": product.media_gallery or [],
            "flash_sale": flash_context.get(product.id),
        }
        result.append(row)

    return result


@router.get("/{sku_or_id}")
def get_product_detail(sku_or_id: str, db: Session = Depends(get_db)) -> dict[str, Any]:
    """Retrieve full product information by UUID or unique SKU."""
    now = datetime.now(UTC)

    # Attempt lookup by UUID or SKU
    query = select(Product)
    try:
        uuid_val = UUID(sku_or_id)
        query = query.where(or_(Product.id == uuid_val, Product.sku == sku_or_id))
    except ValueError:
        query = query.where(Product.sku == sku_or_id)

    product = db.scalar(query)
    if product is None:
        raise HTTPException(status_code=404, detail="Product not found in catalog")

    inv = db.scalar(select(Inventory).where(Inventory.product_id == product.id))
    on_hand = inv.on_hand_quantity if inv else 0
    reserved = inv.reserved_quantity if inv else 0
    available = max(0, on_hand - reserved)

    flash_context = _get_live_flash_context(db, [product.id], now)

    return {
        "id": str(product.id),
        "sku": product.sku,
        "name": product.name,
        "description": product.description,
        "price_cents": product.price_cents,
        "currency": product.currency,
        "is_active": product.is_active,
        "on_hand_quantity": on_hand,
        "available_quantity": available,
        "vendor_id": product.vendor_id,
        "vendor_name": product.vendor_name,
        "category_path": product.category_path,
        "dimensions": product.dimensions,
        "weight": product.weight,
        "media_gallery": product.media_gallery or [],
        "flash_sale": flash_context.get(product.id),
        "created_at": product.created_at.isoformat(),
        "updated_at": product.updated_at.isoformat() if product.updated_at else None,
    }


# ─── Social Proof & Feedback Endpoints ───────────────────────────────────────

@router.post("/{product_id}/feedback", status_code=status.HTTP_201_CREATED)
def submit_product_feedback(
    product_id: UUID,
    payload: FeedbackCreate,
    current_user: Annotated[User, Depends(get_current_user)],
    db: Annotated[Session, Depends(get_db)],
) -> dict[str, Any]:
    """Secure submission path requiring valid bearer authentication token."""
    product = db.get(Product, product_id)
    if product is None:
        raise HTTPException(status_code=404, detail="Product not found")

    existing = db.scalar(
        select(ProductFeedback.id).where(
            ProductFeedback.product_id == product_id,
            ProductFeedback.user_id == current_user.id,
        )
    )
    if existing:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="You have already submitted an evaluation for this product",
        )

    feedback = ProductFeedback(
        product_id=product_id,
        user_id=current_user.id,
        rating_score=payload.rating_score,
        headline=payload.headline.strip(),
        body_text=payload.body_text.strip(),
    )
    db.add(feedback)
    db.commit()
    db.refresh(feedback)

    return {
        "id": str(feedback.id),
        "product_id": str(feedback.product_id),
        "user_id": str(feedback.user_id),
        "user_name": current_user.display_name,
        "rating_score": feedback.rating_score,
        "headline": feedback.headline,
        "body_text": feedback.body_text,
        "created_at": feedback.created_at.isoformat(),
    }


@router.get("/{product_id}/feedback")
def list_product_feedback(
    product_id: UUID,
    limit: int = Query(default=20, ge=1, le=100),
    cursor: str | None = Query(default=None),
    offset: int = Query(default=0, ge=0),
    rating: int | None = Query(default=None, ge=1, le=5),
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    """Publicly accessible feedback array supporting cursor-based or offset pagination and rating filters."""
    product = db.get(Product, product_id)
    if product is None:
        raise HTTPException(status_code=404, detail="Product not found")

    base_q = (
        select(ProductFeedback, User.display_name)
        .join(User, User.id == ProductFeedback.user_id)
        .where(ProductFeedback.product_id == product_id)
    )

    if rating is not None:
        base_q = base_q.where(ProductFeedback.rating_score == rating)

    total_count = db.scalar(select(func.count()).select_from(base_q.subquery())) or 0

    q = base_q.order_by(ProductFeedback.created_at.desc(), ProductFeedback.id.desc())
    if cursor:
        try:
            cursor_dt = datetime.fromisoformat(cursor)
            q = q.where(ProductFeedback.created_at < cursor_dt)
        except Exception:
            pass
    else:
        q = q.offset(offset)

    q = q.limit(limit + 1)
    rows = db.execute(q).all()

    has_next = len(rows) > limit
    data_rows = rows[:limit]
    items = [
        {
            "id": str(fb.id),
            "product_id": str(fb.product_id),
            "user_id": str(fb.user_id),
            "user_name": user_name,
            "rating_score": fb.rating_score,
            "headline": fb.headline,
            "body_text": fb.body_text,
            "created_at": fb.created_at.isoformat(),
        }
        for fb, user_name in data_rows
    ]

    next_cursor = data_rows[-1][0].created_at.isoformat() if has_next and data_rows else None

    return {
        "items": items,
        "total_count": total_count,
        "next_cursor": next_cursor,
    }


@router.get("/{product_id}/feedback/summary")
def get_product_feedback_summary(
    product_id: UUID,
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    """Performance-optimized aggregate quantitative analytics for product reviews."""
    product = db.get(Product, product_id)
    if product is None:
        raise HTTPException(status_code=404, detail="Product not found")

    stats = db.execute(
        select(
            ProductFeedback.rating_score,
            func.count(ProductFeedback.id).label("count"),
        )
        .where(ProductFeedback.product_id == product_id)
        .group_by(ProductFeedback.rating_score)
    ).all()

    counts = {score: 0 for score in range(1, 6)}
    total = 0
    score_sum = 0
    for score, count in stats:
        counts[score] = count
        total += count
        score_sum += score * count

    mean_score = round(score_sum / total, 1) if total > 0 else 0.0

    distribution: dict[str, dict[str, Any]] = {}
    for star in range(1, 6):
        c = counts[star]
        pct = round((c / total) * 100, 1) if total > 0 else 0.0
        distribution[str(star)] = {"count": c, "percentage": pct}

    recommended_count = counts[4] + counts[5]
    recommended_pct = round((recommended_count / total) * 100, 1) if total > 0 else 0.0

    return {
        "mean_score": mean_score,
        "total_count": total,
        "distribution": distribution,
        "recommended_percentage": recommended_pct,
    }
