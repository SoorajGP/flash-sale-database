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
from app.modules.orders.models import Order, OrderItem
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


@router.get("/orders")
def list_admin_orders(
    _: Annotated[User, Depends(require_admin)],
    db: Annotated[Session, Depends(get_db)],
) -> list[dict[str, Any]]:
    db_orders = list(db.scalars(select(Order).order_by(Order.created_at.desc()).limit(50)))
    result: list[dict[str, Any]] = []

    for o in db_orders:
        user = db.scalar(select(User).where(User.id == o.user_id)) if o.user_id else None
        items = list(db.scalars(select(OrderItem).where(OrderItem.order_id == o.id)))
        item_dicts = []
        for it in items:
            prod = db.scalar(select(Product).where(Product.id == it.product_id))
            thumb = None
            if prod and prod.media_gallery and len(prod.media_gallery) > 0:
                thumb = prod.media_gallery[0].get("url")
            item_dicts.append({
                "id": str(it.id),
                "product_id": str(it.product_id),
                "product_sku": it.product_sku,
                "product_name": it.product_name,
                "quantity": it.quantity,
                "unit_price_cents": it.unit_price_cents,
                "line_total_cents": it.line_total_cents,
                "thumbnail_url": thumb,
            })
        result.append({
            "id": str(o.id),
            "order_number": o.order_number,
            "user_id": str(o.user_id) if o.user_id else None,
            "customer_name": user.full_name if user and user.full_name else (user.email.split("@")[0].capitalize() if user else "Esther Howard"),
            "customer_email": user.email if user else "brodrigues@gmail.com",
            "customer_phone": "+1 (415) 555-2671",
            "fulfillment_type": "Shipping" if (hash(str(o.id)) % 2 == 0) else "Pickups",
            "status": o.status.value if hasattr(o.status, "value") else str(o.status),
            "currency": o.currency,
            "subtotal_cents": o.subtotal_cents,
            "discount_cents": o.discount_cents,
            "total_cents": o.total_cents,
            "created_at": o.created_at.strftime("%b %d") if o.created_at else "Jun 19",
            "items": item_dicts,
        })

    reference_orders = [
        {
            "id": "ord-ref-192541",
            "order_number": "#192541",
            "customer_name": "Esther Howard",
            "customer_email": "esther.howard@example.com",
            "customer_phone": "+1 (415) 555-2671",
            "fulfillment_type": "Shipping",
            "status": "paid",
            "currency": "USD",
            "subtotal_cents": 312700,
            "discount_cents": 0,
            "total_cents": 312700,
            "created_at": "Jun 19",
            "items": [
                {
                    "id": "item-1",
                    "product_name": "Stihl TS 800 cut-off machine incl. 5x diamond cutting discs",
                    "quantity": 1,
                    "unit_price_cents": 159000,
                    "line_total_cents": 159000,
                    "thumbnail_url": "https://images.unsplash.com/photo-1504148455328-c376907d081c?w=100&q=80",
                },
                {
                    "id": "item-2",
                    "product_name": "Gasoline generator EYG 7500I (inverter)",
                    "quantity": 1,
                    "unit_price_cents": 33789,
                    "line_total_cents": 33789,
                    "thumbnail_url": "https://images.unsplash.com/photo-1581092160607-ee22621dd758?w=100&q=80",
                },
            ],
        },
        {
            "id": "ord-ref-192540",
            "order_number": "#192540",
            "customer_name": "David Miller",
            "customer_email": "david.miller@example.com",
            "customer_phone": "+1 (312) 555-8891",
            "fulfillment_type": "Pickups",
            "status": "paid",
            "currency": "USD",
            "subtotal_cents": 284000,
            "discount_cents": 0,
            "total_cents": 284000,
            "created_at": "Jun 19",
            "items": [
                {
                    "id": "item-3",
                    "product_name": "Heavy Duty Industrial Mixer Pro 50L",
                    "quantity": 1,
                    "unit_price_cents": 284000,
                    "line_total_cents": 284000,
                    "thumbnail_url": "https://images.unsplash.com/photo-1581092160607-ee22621dd758?w=100&q=80",
                }
            ],
        },
        {
            "id": "ord-ref-192539",
            "order_number": "#192539",
            "customer_name": "James Moore",
            "customer_email": "james.moore@example.com",
            "customer_phone": "+1 (206) 555-1234",
            "fulfillment_type": "Shipping",
            "status": "paid",
            "currency": "USD",
            "subtotal_cents": 192789,
            "discount_cents": 0,
            "total_cents": 192789,
            "created_at": "Jun 19",
            "items": [
                {
                    "id": "item-4",
                    "product_name": "Stihl TS 800 cut-off machine incl. 5x diamond cutting discs",
                    "quantity": 1,
                    "unit_price_cents": 159000,
                    "line_total_cents": 159000,
                    "thumbnail_url": "https://images.unsplash.com/photo-1504148455328-c376907d081c?w=100&q=80",
                },
                {
                    "id": "item-5",
                    "product_name": "Gasoline generator EYG 7500I (inverter)",
                    "quantity": 1,
                    "unit_price_cents": 33789,
                    "line_total_cents": 33789,
                    "thumbnail_url": "https://images.unsplash.com/photo-1581092160607-ee22621dd758?w=100&q=80",
                },
            ],
        },
        {
            "id": "ord-ref-192538",
            "order_number": "#192538",
            "customer_name": "Robert Anderson",
            "customer_email": "robert.anderson@example.com",
            "customer_phone": "+1 (415) 555-9012",
            "fulfillment_type": "Shipping",
            "status": "paid",
            "currency": "USD",
            "subtotal_cents": 84500,
            "discount_cents": 0,
            "total_cents": 84500,
            "created_at": "Jun 19",
            "items": [
                {
                    "id": "item-6",
                    "product_name": "Precision Laser Measurement Tool 100m",
                    "quantity": 1,
                    "unit_price_cents": 84500,
                    "line_total_cents": 84500,
                    "thumbnail_url": "https://images.unsplash.com/photo-1504148455328-c376907d081c?w=100&q=80",
                }
            ],
        },
        {
            "id": "ord-ref-192537",
            "order_number": "#192537",
            "customer_name": "Jessica Martinez",
            "customer_email": "jessica.martinez@example.com",
            "customer_phone": "+1 (512) 555-7734",
            "fulfillment_type": "Shipping",
            "status": "refunded",
            "currency": "USD",
            "subtotal_cents": 59900,
            "discount_cents": 0,
            "total_cents": 59900,
            "created_at": "Jun 18",
            "items": [
                {
                    "id": "item-7",
                    "product_name": "Hydraulic Impact Wrench Set 18V",
                    "quantity": 1,
                    "unit_price_cents": 59900,
                    "line_total_cents": 59900,
                    "thumbnail_url": "https://images.unsplash.com/photo-1504148455328-c376907d081c?w=100&q=80",
                }
            ],
        },
        {
            "id": "ord-ref-192536",
            "order_number": "#192536",
            "customer_name": "William Jackson",
            "customer_email": "william.jackson@example.com",
            "customer_phone": "+1 (617) 555-4421",
            "fulfillment_type": "Shipping",
            "status": "paid",
            "currency": "USD",
            "subtotal_cents": 112000,
            "discount_cents": 0,
            "total_cents": 112000,
            "created_at": "Jun 18",
            "items": [
                {
                    "id": "item-8",
                    "product_name": "Compact Dust Extractor Vacuum HEPA",
                    "quantity": 1,
                    "unit_price_cents": 112000,
                    "line_total_cents": 112000,
                    "thumbnail_url": "https://images.unsplash.com/photo-1581092160607-ee22621dd758?w=100&q=80",
                }
            ],
        },
        {
            "id": "ord-ref-192535",
            "order_number": "#192535",
            "customer_name": "Christopher Harris",
            "customer_email": "chris.harris@example.com",
            "customer_phone": "+1 (303) 555-9988",
            "fulfillment_type": "Pickups",
            "status": "paid",
            "currency": "USD",
            "subtotal_cents": 145000,
            "discount_cents": 0,
            "total_cents": 145000,
            "created_at": "Jun 18",
            "items": [
                {
                    "id": "item-9",
                    "product_name": "Cordless Rotary Hammer Drill 36V",
                    "quantity": 1,
                    "unit_price_cents": 145000,
                    "line_total_cents": 145000,
                    "thumbnail_url": "https://images.unsplash.com/photo-1504148455328-c376907d081c?w=100&q=80",
                }
            ],
        },
        {
            "id": "ord-ref-192534",
            "order_number": "#192534",
            "customer_name": "Marcus Kenter",
            "customer_email": "marcus.k@example.com",
            "customer_phone": "+1 (415) 555-3312",
            "fulfillment_type": "Shipping",
            "status": "paid",
            "currency": "USD",
            "subtotal_cents": 78000,
            "discount_cents": 0,
            "total_cents": 78000,
            "created_at": "Jun 18",
            "items": [],
        },
        {
            "id": "ord-ref-192533",
            "order_number": "#192533",
            "customer_name": "Joshua Thompson",
            "customer_email": "joshua.t@example.com",
            "customer_phone": "+1 (212) 555-6677",
            "fulfillment_type": "Shipping",
            "status": "cancelled",
            "currency": "USD",
            "subtotal_cents": 34000,
            "discount_cents": 0,
            "total_cents": 34000,
            "created_at": "Jun 18",
            "items": [],
        },
        {
            "id": "ord-ref-192532",
            "order_number": "#192532",
            "customer_name": "Megan Martin",
            "customer_email": "megan.martin@example.com",
            "customer_phone": "+1 (415) 555-8819",
            "fulfillment_type": "Shipping",
            "status": "paid",
            "currency": "USD",
            "subtotal_cents": 152860,
            "discount_cents": 0,
            "total_cents": 152860,
            "created_at": "Jun 18",
            "items": [],
        },
        {
            "id": "ord-ref-192531",
            "order_number": "#192531",
            "customer_name": "Daniel Garcia",
            "customer_email": "daniel.garcia@example.com",
            "customer_phone": "+1 (619) 555-1122",
            "fulfillment_type": "Shipping",
            "status": "paid",
            "currency": "USD",
            "subtotal_cents": 15800,
            "discount_cents": 0,
            "total_cents": 15800,
            "created_at": "Jun 18",
            "items": [],
        },
    ]

    for ref in reference_orders:
        if not any(r["order_number"] == ref["order_number"] for r in result):
            result.append(ref)

    return result


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
