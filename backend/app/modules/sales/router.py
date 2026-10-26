"""
Flash Sale Router
=================
Public endpoints:
  GET  /api/v1/flash-sales          – list currently live sales

Admin endpoints (require Bearer + admin role):
  POST /api/v1/admin/flash-sales                    – create a new sale (with overlap guard)
  POST /api/v1/admin/flash-sales/{id}/products      – attach a product to a sale

Overlap guard (requirement §2.3):
  A product may not belong to two sales whose time windows intersect.
  The check is performed by querying existing FlashSaleProduct rows for the
  same product_id where the corresponding FlashSale windows overlap with the
  proposed window.  If any are found, HTTP 400 is returned.
"""
from __future__ import annotations

from datetime import UTC, datetime
from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field
from sqlalchemy import and_, select
from sqlalchemy.orm import Session

from app.core.security import require_admin
from app.db.session import get_db
from app.modules.catalog.models import Product
from app.modules.sales.models import FlashSale, FlashSaleProduct, FlashSaleStatus
from app.modules.users.models import User

router = APIRouter(prefix="/flash-sales", tags=["flash sales"])
admin_router = APIRouter(prefix="/admin/flash-sales", tags=["admin"])


# ─── Request schemas ────────────────────────────────────────────────────────

class FlashSaleCreate(BaseModel):
    name: str = Field(min_length=3, max_length=255)
    starts_at: datetime
    ends_at: datetime


class FlashSaleProductCreate(BaseModel):
    product_id: UUID
    sale_price_cents: int = Field(ge=0)
    allocation_quantity: int = Field(ge=1)
    per_customer_limit: int = Field(default=1, ge=1)


# ─── Helper ─────────────────────────────────────────────────────────────────

def _windows_overlap(s1_start: datetime, s1_end: datetime, s2_start: datetime, s2_end: datetime) -> bool:
    """Return True when two half-open [start, end) intervals overlap."""
    return s1_start < s2_end and s2_start < s1_end


# ─── Public routes ──────────────────────────────────────────────────────────

@router.get("")
def list_live_sales(db: Annotated[Session, Depends(get_db)]) -> list[dict]:
    """Return all sales currently in LIVE status whose window is active."""
    now = datetime.now(UTC)
    sales = db.scalars(
        select(FlashSale).where(
            FlashSale.status == FlashSaleStatus.LIVE,
            FlashSale.starts_at <= now,
            FlashSale.ends_at > now,
        )
    )
    return [
        {
            "id": str(sale.id),
            "name": sale.name,
            "starts_at": sale.starts_at,
            "ends_at": sale.ends_at,
        }
        for sale in sales
    ]


# ─── Admin routes ────────────────────────────────────────────────────────────

@admin_router.get("")
def list_all_sales(
    _: Annotated[User, Depends(require_admin)],
    db: Annotated[Session, Depends(get_db)],
) -> list[dict]:
    """Return all flash sales (any status) for the admin UI."""
    sales = db.scalars(select(FlashSale).order_by(FlashSale.starts_at.desc()))
    return [
        {
            "id": str(s.id),
            "name": s.name,
            "status": s.status.value,
            "starts_at": s.starts_at,
            "ends_at": s.ends_at,
        }
        for s in sales
    ]


@admin_router.post("", status_code=status.HTTP_201_CREATED)
def create_sale(
    payload: FlashSaleCreate,
    _: Annotated[User, Depends(require_admin)],
    db: Annotated[Session, Depends(get_db)],
) -> dict:
    """
    Create a new flash sale event.

    Validates:
    - ends_at must be strictly after starts_at
    - Status is auto-set: LIVE if window is currently active, otherwise SCHEDULED
    """
    if payload.ends_at <= payload.starts_at:
        raise HTTPException(status_code=422, detail="The sale must end after it begins")

    now = datetime.now(UTC)
    current_status = (
        FlashSaleStatus.LIVE
        if payload.starts_at <= now < payload.ends_at
        else FlashSaleStatus.SCHEDULED
    )
    sale = FlashSale(
        name=payload.name,
        starts_at=payload.starts_at,
        ends_at=payload.ends_at,
        status=current_status,
    )
    db.add(sale)
    db.commit()
    return {"id": str(sale.id), "name": sale.name, "status": sale.status.value}


@admin_router.post("/{sale_id}/products", status_code=status.HTTP_201_CREATED)
def add_sale_product(
    sale_id: UUID,
    payload: FlashSaleProductCreate,
    _: Annotated[User, Depends(require_admin)],
    db: Annotated[Session, Depends(get_db)],
) -> dict:
    """
    Attach a product to a flash sale with a discounted price and allocation.

    Overlap guard (requirement §2.3):
      Rejects the request with HTTP 400 if the same product_id already appears
      in any other FlashSale whose time window overlaps with *this* sale's window.
      Two windows [A.start, A.end) and [B.start, B.end) overlap when:
          A.start < B.end AND B.start < A.end
    """
    # Load and validate parent records
    sale = db.get(FlashSale, sale_id)
    if sale is None:
        raise HTTPException(status_code=404, detail="Flash sale not found")
    if db.get(Product, payload.product_id) is None:
        raise HTTPException(status_code=404, detail="Product not found")

    # Reject if the product is already mapped to *this* sale
    existing = db.scalar(
        select(FlashSaleProduct.id).where(
            FlashSaleProduct.flash_sale_id == sale_id,
            FlashSaleProduct.product_id == payload.product_id,
        )
    )
    if existing:
        raise HTTPException(status_code=409, detail="Product is already in this sale")

    # ── Overlap guard ─────────────────────────────────────────────────────
    # Find any OTHER sale that already contains this product and whose window
    # overlaps with the current sale's window.
    overlapping_fsp = db.scalar(
        select(FlashSaleProduct.id)
        .join(FlashSale, FlashSale.id == FlashSaleProduct.flash_sale_id)
        .where(
            FlashSaleProduct.product_id == payload.product_id,
            FlashSaleProduct.flash_sale_id != sale_id,          # exclude this sale
            # Overlap predicate: A.start < B.end AND B.start < A.end
            and_(
                FlashSale.starts_at < sale.ends_at,
                FlashSale.ends_at > sale.starts_at,
            ),
        )
    )
    if overlapping_fsp:
        raise HTTPException(
            status_code=400,
            detail=(
                "This product is already assigned to another flash sale with an "
                "overlapping time window. Adjust the sale dates or remove the "
                "product from the conflicting sale first."
            ),
        )
    # ─────────────────────────────────────────────────────────────────────

    entry = FlashSaleProduct(flash_sale_id=sale_id, **payload.model_dump())
    db.add(entry)
    db.commit()
    return {
        "id": str(entry.id),
        "flash_sale_id": str(sale_id),
        "product_id": str(entry.product_id),
    }
