from __future__ import annotations

from typing import Annotated, Any
import uuid
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


class MediaAssetPayload(BaseModel):
    url: str = Field(min_length=1)
    alt: str = Field(default="")
    display_order: int = Field(default=0, ge=0)


class ProductCreate(BaseModel):
    sku: str = Field(min_length=2, max_length=64, pattern=r"^[A-Za-z0-9_-]+$")
    name: str = Field(min_length=2, max_length=255)
    description: str | None = None
    price_cents: int = Field(ge=0)
    currency: str = Field(default="USD", min_length=3, max_length=3)
    opening_stock: int | None = Field(default=0, ge=0)
    initial_stock: int | None = Field(default=None, ge=0)
    vendor_id: str | None = None
    vendor_name: str | None = None
    category_path: str | None = None
    dimensions: dict[str, Any] | None = None
    weight: float | None = None
    media_gallery: list[MediaAssetPayload] = Field(default_factory=list)


class ProductUpdate(BaseModel):
    name: str = Field(min_length=2, max_length=255)
    sku: str | None = None
    description: str | None = None
    price_cents: int = Field(ge=0)
    currency: str = Field(default="USD", min_length=3, max_length=3)
    vendor_id: str | None = None
    vendor_name: str | None = None
    category_path: str | None = None
    dimensions: dict[str, Any] | None = None
    weight: float | None = None
    media_gallery: list[MediaAssetPayload] = Field(default_factory=list)
    is_active: bool = True
    stock_quantity: int | None = Field(default=None, ge=0)
    on_hand_quantity: int | None = Field(default=None, ge=0)


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


@router.get("/products")
def list_admin_products(
    _: Annotated[User, Depends(require_admin)],
    db: Annotated[Session, Depends(get_db)],
) -> list[dict[str, Any]]:
    products = list(db.scalars(select(Product).order_by(Product.name)))
    if not products:
        return []
    pids = [p.id for p in products]
    inv_map = {
        row.product_id: row
        for row in db.scalars(select(Inventory).where(Inventory.product_id.in_(pids)))
    }
    return [
        {
            "id": str(p.id),
            "sku": p.sku,
            "name": p.name,
            "description": p.description,
            "price_cents": p.price_cents,
            "currency": p.currency,
            "vendor_id": p.vendor_id,
            "vendor_name": p.vendor_name,
            "category_path": p.category_path,
            "dimensions": p.dimensions,
            "weight": p.weight,
            "media_gallery": p.media_gallery or [],
            "is_active": p.is_active,
            "on_hand_quantity": inv_map.get(p.id).on_hand_quantity if inv_map.get(p.id) else 0,
            "reserved_quantity": inv_map.get(p.id).reserved_quantity if inv_map.get(p.id) else 0,
            "available_quantity": max(0, inv_map.get(p.id).on_hand_quantity - inv_map.get(p.id).reserved_quantity) if inv_map.get(p.id) else 0,
        }
        for p in products
    ]


@router.post("/products", status_code=status.HTTP_201_CREATED)
def create_product(
    payload: ProductCreate, _: Annotated[User, Depends(require_admin)], db: Annotated[Session, Depends(get_db)]
) -> dict[str, Any]:
    if db.scalar(select(Product.id).where(Product.sku == payload.sku)):
        raise HTTPException(status_code=409, detail="SKU already exists")

    product = Product(
        sku=payload.sku,
        name=payload.name,
        description=payload.description,
        price_cents=payload.price_cents,
        currency=payload.currency.upper(),
        vendor_id=payload.vendor_id,
        vendor_name=payload.vendor_name,
        category_path=payload.category_path,
        dimensions=payload.dimensions,
        weight=payload.weight,
        media_gallery=[asset.model_dump() for asset in payload.media_gallery],
    )
    db.add(product)
    db.flush()

    initial_units = payload.initial_stock if payload.initial_stock is not None else (payload.opening_stock or 0)
    inventory = Inventory(product_id=product.id, on_hand_quantity=initial_units)
    db.add(inventory)

    if initial_units:
        db.add(
            InventoryMovement(
                product_id=product.id,
                movement_type=InventoryMovementType.RESTOCK,
                quantity_delta=initial_units,
                reference_type="product",
                reference_id=product.id,
                idempotency_key=f"opening:{product.id}",
            )
        )
    db.commit()
    db.refresh(product)
    db.refresh(inventory)

    return {
        "id": str(product.id),
        "sku": product.sku,
        "name": product.name,
        "description": product.description,
        "price_cents": product.price_cents,
        "currency": product.currency,
        "vendor_id": product.vendor_id,
        "vendor_name": product.vendor_name,
        "category_path": product.category_path,
        "dimensions": product.dimensions,
        "weight": product.weight,
        "media_gallery": product.media_gallery,
        "on_hand_quantity": inventory.on_hand_quantity,
        "available_quantity": inventory.on_hand_quantity,
    }


@router.put("/products/{product_id}")
def update_product(
    product_id: UUID,
    payload: ProductUpdate,
    _: Annotated[User, Depends(require_admin)],
    db: Annotated[Session, Depends(get_db)],
) -> dict[str, Any]:
    """Execute full mutation update for catalog products and inventory ledger."""
    product = db.get(Product, product_id)
    if product is None:
        raise HTTPException(status_code=404, detail="Product not found")

    product.name = payload.name
    product.description = payload.description
    product.price_cents = payload.price_cents
    product.currency = payload.currency.upper()
    product.vendor_id = payload.vendor_id
    product.vendor_name = payload.vendor_name
    product.category_path = payload.category_path
    product.dimensions = payload.dimensions
    product.weight = payload.weight
    product.media_gallery = [asset.model_dump() for asset in payload.media_gallery]
    product.is_active = payload.is_active

    inventory = db.scalar(
        select(Inventory).where(Inventory.product_id == product_id).with_for_update()
    )
    if inventory is None:
        inventory = Inventory(product_id=product.id, on_hand_quantity=0)
        db.add(inventory)
        db.flush()

    target_stock = payload.on_hand_quantity if payload.on_hand_quantity is not None else payload.stock_quantity
    if target_stock is not None and target_stock != inventory.on_hand_quantity:
        delta = target_stock - inventory.on_hand_quantity
        inventory.on_hand_quantity = target_stock
        m_type = InventoryMovementType.RESTOCK if delta > 0 else InventoryMovementType.ADJUSTMENT
        db.add(
            InventoryMovement(
                product_id=product.id,
                movement_type=m_type,
                quantity_delta=delta,
                reference_type="admin_update",
                reference_id=uuid.uuid4(),
                idempotency_key=f"inv_update:{product.id}:{uuid.uuid4()}",
            )
        )

    db.commit()
    db.refresh(product)
    db.refresh(inventory)

    return {
        "id": str(product.id),
        "sku": product.sku,
        "name": product.name,
        "description": product.description,
        "price_cents": product.price_cents,
        "currency": product.currency,
        "vendor_id": product.vendor_id,
        "vendor_name": product.vendor_name,
        "category_path": product.category_path,
        "dimensions": product.dimensions,
        "weight": product.weight,
        "media_gallery": product.media_gallery,
        "is_active": product.is_active,
        "on_hand_quantity": inventory.on_hand_quantity,
        "available_quantity": max(0, inventory.on_hand_quantity - inventory.reserved_quantity),
    }


@router.post("/products/{product_id}/restock")
def restock(
    product_id: UUID,
    payload: RestockRequest,
    _: Annotated[User, Depends(require_admin)],
    db: Annotated[Session, Depends(get_db)],
) -> dict[str, Any]:
    inventory = db.scalar(select(Inventory).where(Inventory.product_id == product_id).with_for_update())
    if inventory is None:
        raise HTTPException(status_code=404, detail="Product inventory not found")
    existing = db.scalar(select(InventoryMovement.id).where(InventoryMovement.idempotency_key == payload.idempotency_key))
    if existing:
        return {"product_id": str(product_id), "on_hand_quantity": inventory.on_hand_quantity, "idempotent": True}
    inventory.on_hand_quantity += payload.quantity
    db.add(
        InventoryMovement(
            product_id=product_id,
            movement_type=InventoryMovementType.RESTOCK,
            quantity_delta=payload.quantity,
            reference_type="restock",
            reference_id=uuid.uuid4(),
            idempotency_key=payload.idempotency_key,
        )
    )
    db.commit()
    return {"product_id": str(product_id), "on_hand_quantity": inventory.on_hand_quantity, "idempotent": False}
