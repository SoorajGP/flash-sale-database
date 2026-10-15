from __future__ import annotations

import uuid
from datetime import UTC, datetime, timedelta
from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.db.session import get_db
from app.modules.carts.models import Cart, CartItem, CartStatus
from app.modules.catalog.models import Product

router = APIRouter(prefix="/carts", tags=["carts"])


class CartCreate(BaseModel):
    session_id: str | None = Field(default=None, min_length=8, max_length=255)


class CartItemCreate(BaseModel):
    product_id: UUID
    quantity: int = Field(ge=1, le=20)
    flash_sale_product_id: UUID | None = None


def cart_payload(cart: Cart, items: list[CartItem], products: dict[UUID, Product]) -> dict:
    return {
        "id": str(cart.id), "status": cart.status.value, "expires_at": cart.expires_at,
        "items": [
            {"id": str(item.id), "product_id": str(item.product_id), "name": products[item.product_id].name,
             "quantity": item.quantity, "unit_price_cents": products[item.product_id].price_cents}
            for item in items
        ],
    }


@router.post("", status_code=status.HTTP_201_CREATED)
def create_cart(
    payload: CartCreate, db: Annotated[Session, Depends(get_db)]
) -> dict:
    session_id = payload.session_id or str(uuid.uuid4())
    cart = Cart(session_id=session_id, status=CartStatus.ACTIVE, expires_at=datetime.now(UTC) + timedelta(days=7))
    db.add(cart)
    db.commit()
    db.refresh(cart)
    return {"id": str(cart.id), "session_id": session_id, "status": cart.status.value}


@router.post("/{cart_id}/items")
def add_item(cart_id: UUID, payload: CartItemCreate, db: Annotated[Session, Depends(get_db)]) -> dict:
    cart = db.get(Cart, cart_id)
    if cart is None or cart.status is not CartStatus.ACTIVE:
        raise HTTPException(status_code=404, detail="Active cart not found")
    product = db.get(Product, payload.product_id)
    if product is None or not product.is_active:
        raise HTTPException(status_code=404, detail="Active product not found")
    item = db.scalar(select(CartItem).where(CartItem.cart_id == cart_id, CartItem.product_id == payload.product_id))
    if item:
        item.quantity += payload.quantity
    else:
        item = CartItem(cart_id=cart_id, product_id=payload.product_id, quantity=payload.quantity, flash_sale_product_id=payload.flash_sale_product_id)
        db.add(item)
    db.commit()
    return {"cart_id": str(cart_id), "item_id": str(item.id), "quantity": item.quantity}


@router.get("/{cart_id}")
def get_cart(cart_id: UUID, db: Annotated[Session, Depends(get_db)]) -> dict:
    cart = db.get(Cart, cart_id)
    if cart is None:
        raise HTTPException(status_code=404, detail="Cart not found")
    items = list(db.scalars(select(CartItem).where(CartItem.cart_id == cart_id)))
    products = {product.id: product for product in db.scalars(select(Product).where(Product.id.in_([item.product_id for item in items])))}
    return cart_payload(cart, items, products)
