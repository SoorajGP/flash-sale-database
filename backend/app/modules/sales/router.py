from __future__ import annotations

from datetime import UTC, datetime
from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.security import require_admin
from app.db.session import get_db
from app.modules.catalog.models import Product
from app.modules.sales.models import FlashSale, FlashSaleProduct, FlashSaleStatus
from app.modules.users.models import User

router = APIRouter(prefix="/flash-sales", tags=["flash sales"])
admin_router = APIRouter(prefix="/admin/flash-sales", tags=["admin"])


class FlashSaleCreate(BaseModel):
    name: str = Field(min_length=3, max_length=255)
    starts_at: datetime
    ends_at: datetime


class FlashSaleProductCreate(BaseModel):
    product_id: UUID
    sale_price_cents: int = Field(ge=0)
    allocation_quantity: int = Field(ge=1)
    per_customer_limit: int = Field(default=1, ge=1)


@router.get("")
def list_live_sales(db: Annotated[Session, Depends(get_db)]) -> list[dict]:
    now = datetime.now(UTC)
    sales = db.scalars(select(FlashSale).where(FlashSale.status == FlashSaleStatus.LIVE, FlashSale.starts_at <= now, FlashSale.ends_at > now))
    return [{"id": str(sale.id), "name": sale.name, "starts_at": sale.starts_at, "ends_at": sale.ends_at} for sale in sales]


@admin_router.post("", status_code=status.HTTP_201_CREATED)
def create_sale(
    payload: FlashSaleCreate, _: Annotated[User, Depends(require_admin)], db: Annotated[Session, Depends(get_db)]
) -> dict:
    if payload.ends_at <= payload.starts_at:
        raise HTTPException(status_code=422, detail="The sale must end after it begins")
    current_status = FlashSaleStatus.LIVE if payload.starts_at <= datetime.now(UTC) < payload.ends_at else FlashSaleStatus.SCHEDULED
    sale = FlashSale(name=payload.name, starts_at=payload.starts_at, ends_at=payload.ends_at, status=current_status)
    db.add(sale)
    db.commit()
    return {"id": str(sale.id), "name": sale.name, "status": sale.status.value}


@admin_router.post("/{sale_id}/products", status_code=status.HTTP_201_CREATED)
def add_sale_product(
    sale_id: UUID, payload: FlashSaleProductCreate, _: Annotated[User, Depends(require_admin)], db: Annotated[Session, Depends(get_db)]
) -> dict:
    if db.get(FlashSale, sale_id) is None or db.get(Product, payload.product_id) is None:
        raise HTTPException(status_code=404, detail="Flash sale or product not found")
    existing = db.scalar(select(FlashSaleProduct.id).where(FlashSaleProduct.flash_sale_id == sale_id, FlashSaleProduct.product_id == payload.product_id))
    if existing:
        raise HTTPException(status_code=409, detail="Product is already in this sale")
    entry = FlashSaleProduct(flash_sale_id=sale_id, **payload.model_dump())
    db.add(entry)
    db.commit()
    return {"id": str(entry.id), "flash_sale_id": str(sale_id), "product_id": str(entry.product_id)}
