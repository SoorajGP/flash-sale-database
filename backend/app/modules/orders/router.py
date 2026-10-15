from __future__ import annotations

import uuid
from datetime import UTC, datetime, timedelta
from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.config import get_settings
from app.db.session import get_db
from app.modules.carts.models import Cart, CartItem, CartStatus
from app.modules.catalog.models import Product
from app.modules.inventory.models import Inventory, InventoryMovement, InventoryMovementType, InventoryReservation, ReservationStatus
from app.modules.orders.models import Order, OrderItem, OrderStatus
from app.modules.payments.models import Payment, PaymentStatus

router = APIRouter(prefix="/orders", tags=["orders"])


def order_payload(order: Order) -> dict:
    return {"id": str(order.id), "order_number": order.order_number, "status": order.status.value, "total_cents": order.total_cents, "currency": order.currency}


@router.post("/checkout/{cart_id}", status_code=201)
def checkout(cart_id: UUID, db: Annotated[Session, Depends(get_db)]) -> dict:
    """Reserve each cart item inside one transaction; payment confirmation commits stock."""
    cart = db.scalar(select(Cart).where(Cart.id == cart_id).with_for_update())
    if cart is None or cart.status is not CartStatus.ACTIVE:
        raise HTTPException(status_code=404, detail="Active cart not found")
    items = list(db.scalars(select(CartItem).where(CartItem.cart_id == cart_id)))
    if not items:
        raise HTTPException(status_code=422, detail="A cart needs at least one item")
    product_ids = [item.product_id for item in items]
    inventory_by_product = {
        row.product_id: row for row in db.scalars(select(Inventory).where(Inventory.product_id.in_(product_ids)).with_for_update())
    }
    products = {row.id: row for row in db.scalars(select(Product).where(Product.id.in_(product_ids)))}
    for item in items:
        inventory = inventory_by_product.get(item.product_id)
        if inventory is None or inventory.on_hand_quantity - inventory.reserved_quantity < item.quantity:
            raise HTTPException(status_code=409, detail=f"{products[item.product_id].name} is no longer available")
    now = datetime.now(UTC)
    subtotal = sum(products[item.product_id].price_cents * item.quantity for item in items)
    order = Order(
        order_number=f"SC-{now:%Y%m%d}-{uuid.uuid4().hex[:7].upper()}", cart_id=cart.id, user_id=cart.user_id,
        subtotal_cents=subtotal, total_cents=subtotal, currency="USD", status=OrderStatus.PENDING_PAYMENT,
    )
    db.add(order)
    db.flush()
    for item in items:
        product, inventory = products[item.product_id], inventory_by_product[item.product_id]
        inventory.reserved_quantity += item.quantity
        db.add(OrderItem(order_id=order.id, product_id=product.id, product_sku=product.sku, product_name=product.name,
                         unit_price_cents=product.price_cents, quantity=item.quantity, line_total_cents=product.price_cents * item.quantity))
        db.add(InventoryReservation(product_id=product.id, cart_id=cart.id, order_id=order.id, quantity=item.quantity,
                                    status=ReservationStatus.ACTIVE, expires_at=now + timedelta(minutes=10)))
        db.add(InventoryMovement(product_id=product.id, movement_type=InventoryMovementType.RESERVE, quantity_delta=-item.quantity,
                                 reference_type="order", reference_id=order.id, idempotency_key=f"reserve:{order.id}:{product.id}"))
    payment = Payment(order_id=order.id, provider="demo", provider_reference=f"demo_{uuid.uuid4().hex}", status=PaymentStatus.PENDING,
                      amount_cents=order.total_cents, currency=order.currency)
    cart.status = CartStatus.CHECKED_OUT
    db.add(payment)
    db.commit()
    return {**order_payload(order), "payment_reference": payment.provider_reference, "reservation_expires_at": now + timedelta(minutes=10)}


@router.post("/{order_id}/pay")
def confirm_demo_payment(order_id: UUID, db: Annotated[Session, Depends(get_db)]) -> dict:
    """Demo-only payment confirmation. Replace with verified Stripe webhook handling in production."""
    if not get_settings().demo_payments_enabled:
        raise HTTPException(status_code=403, detail="Demo payments are disabled")
    order = db.scalar(select(Order).where(Order.id == order_id).with_for_update())
    if order is None:
        raise HTTPException(status_code=404, detail="Order not found")
    payment = db.scalar(select(Payment).where(Payment.order_id == order_id).with_for_update())
    if payment is None:
        raise HTTPException(status_code=409, detail="Payment record not found")
    if payment.status is PaymentStatus.PAID:
        return order_payload(order)
    reservations = list(db.scalars(select(InventoryReservation).where(InventoryReservation.order_id == order_id, InventoryReservation.status == ReservationStatus.ACTIVE).with_for_update()))
    if not reservations or any(row.expires_at < datetime.now(UTC) for row in reservations):
        raise HTTPException(status_code=409, detail="The payment hold has expired")
    for reservation in reservations:
        inventory = db.scalar(select(Inventory).where(Inventory.product_id == reservation.product_id).with_for_update())
        if inventory is None:
            raise HTTPException(status_code=409, detail="Inventory record missing")
        inventory.on_hand_quantity -= reservation.quantity
        inventory.reserved_quantity -= reservation.quantity
        reservation.status = ReservationStatus.COMMITTED
        db.add(InventoryMovement(product_id=reservation.product_id, movement_type=InventoryMovementType.COMMIT, quantity_delta=-reservation.quantity,
                                 reference_type="order", reference_id=order.id, idempotency_key=f"commit:{order.id}:{reservation.product_id}"))
    payment.status = PaymentStatus.PAID
    order.status = OrderStatus.PAID
    db.commit()
    return order_payload(order)
