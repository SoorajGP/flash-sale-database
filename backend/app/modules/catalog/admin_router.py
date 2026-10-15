from __future__ import annotations

import uuid
from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.core.security import require_admin
from app.db.session import get_db
from app.modules.catalog.models import Product
from app.modules.inventory.models import Inventory, InventoryMovement, InventoryMovementType
from app.modules.orders.models import Order
from app.modules.users.models import User

router = APIRouter(prefix="/admin", tags=["admin"])


class ProductCreate(BaseModel):
    sku: str = Field(min_length=2, max_length=64, pattern=r"^[A-Za-z0-9_-]+$")
    name: str = Field(min_length=2, max_length=255)
    description: str | None = None
    price_cents: int = Field(ge=0)
    currency: str = Field(default="USD", min_length=3, max_length=3)
    opening_stock: int = Field(default=0, ge=0)


class RestockRequest(BaseModel):
    quantity: int = Field(ge=1)
    idempotency_key: str = Field(min_length=8, max_length=255)


@router.get("/dashboard")
def dashboard(_: Annotated[User, Depends(require_admin)], db: Annotated[Session, Depends(get_db)]) -> dict:
    return {
        "products": db.scalar(select(func.count()).select_from(Product)) or 0,
        "orders": db.scalar(select(func.count()).select_from(Order)) or 0,
        "order_total_cents": db.scalar(select(func.coalesce(func.sum(Order.total_cents), 0))) or 0,
    }


@router.post("/products", status_code=status.HTTP_201_CREATED)
def create_product(
    payload: ProductCreate, _: Annotated[User, Depends(require_admin)], db: Annotated[Session, Depends(get_db)]
) -> dict:
    if db.scalar(select(Product.id).where(Product.sku == payload.sku)):
        raise HTTPException(status_code=409, detail="SKU already exists")
    product = Product(sku=payload.sku, name=payload.name, description=payload.description,
                      price_cents=payload.price_cents, currency=payload.currency.upper())
    db.add(product)
    db.flush()
    inventory = Inventory(product_id=product.id, on_hand_quantity=payload.opening_stock)
    db.add(inventory)
    if payload.opening_stock:
        db.add(InventoryMovement(product_id=product.id, movement_type=InventoryMovementType.RESTOCK,
                                 quantity_delta=payload.opening_stock, reference_type="product", reference_id=product.id,
                                 idempotency_key=f"opening:{product.id}"))
    db.commit()
    return {"id": str(product.id), "sku": product.sku, "opening_stock": inventory.on_hand_quantity}


@router.post("/products/{product_id}/restock")
def restock(
    product_id: UUID, payload: RestockRequest, _: Annotated[User, Depends(require_admin)], db: Annotated[Session, Depends(get_db)]
) -> dict:
    inventory = db.scalar(select(Inventory).where(Inventory.product_id == product_id).with_for_update())
    if inventory is None:
        raise HTTPException(status_code=404, detail="Product inventory not found")
    existing = db.scalar(select(InventoryMovement.id).where(InventoryMovement.idempotency_key == payload.idempotency_key))
    if existing:
        return {"product_id": str(product_id), "on_hand_quantity": inventory.on_hand_quantity, "idempotent": True}
    inventory.on_hand_quantity += payload.quantity
    db.add(InventoryMovement(product_id=product_id, movement_type=InventoryMovementType.RESTOCK,
                             quantity_delta=payload.quantity, reference_type="restock", reference_id=uuid.uuid4(),
                             idempotency_key=payload.idempotency_key))
    db.commit()
    return {"product_id": str(product_id), "on_hand_quantity": inventory.on_hand_quantity, "idempotent": False}
