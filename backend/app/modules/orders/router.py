from __future__ import annotations

import uuid
from datetime import UTC, datetime, timedelta
from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, Header, HTTPException, status
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.core.config import get_settings
from app.core.redis import check_rate_limit, fast_reserve_stock, set_product_stock_cache
from app.db.session import get_db
from app.modules.carts.models import Cart, CartItem, CartStatus
from app.modules.catalog.models import Product
from app.modules.inventory.models import (
    Inventory,
    InventoryMovement,
    InventoryMovementType,
    InventoryReservation,
    ReservationStatus,
)
from app.modules.inventory.service import release_expired_reservations
from app.modules.orders.models import Order, OrderItem, OrderStatus
from app.modules.payments.models import Payment, PaymentStatus
from app.modules.sales.models import FlashSale, FlashSaleProduct, FlashSaleStatus

router = APIRouter(prefix="/orders", tags=["orders"])


def ensure_utc(dt: datetime) -> datetime:
    if dt.tzinfo is None:
        return dt.replace(tzinfo=UTC)
    return dt.astimezone(UTC)


def order_payload(order: Order, payment_reference: str | None = None, reservation_expires_at: datetime | None = None) -> dict:
    payload = {
        "id": str(order.id),
        "order_number": order.order_number,
        "status": order.status.value,
        "subtotal_cents": order.subtotal_cents,
        "discount_cents": order.discount_cents,
        "total_cents": order.total_cents,
        "currency": order.currency,
    }
    if payment_reference:
        payload["payment_reference"] = payment_reference
    if reservation_expires_at:
        payload["reservation_expires_at"] = reservation_expires_at
    return payload


@router.post("/checkout/{cart_id}", status_code=status.HTTP_201_CREATED)
def checkout(
    cart_id: UUID,
    db: Annotated[Session, Depends(get_db)],
    idempotency_key: Annotated[str | None, Header(alias="Idempotency-Key")] = None,
    queue_token: Annotated[str | None, Header(alias="X-Queue-Admission-Token")] = None,
) -> dict:
    """
    High-concurrency flash sale checkout:
    0. Virtual waiting room admission gate (token bucket / leaky bucket).
    1. Rate limit protection per cart / client.
    2. Lazy cleanup of expired holds so reclaimed stock is immediately available.
    3. Fast-failure stock check.
    4. Deterministic ascending row lock order to prevent deadlocks.
    5. Flash sale allocation and per-customer limit validation.
    6. Atomic stock reservation and order snapshot creation.
    """
    # 0. Virtual Waiting Room verification
    from app.modules.waiting_room.service import is_waiting_room_active, verify_and_consume_token
    if is_waiting_room_active():
        if not queue_token or not verify_and_consume_token(queue_token, str(cart_id)):
            raise HTTPException(
                status_code=status.HTTP_429_TOO_MANY_REQUESTS,
                detail="Virtual waiting room active. An admitted queue ticket is required before checkout.",
                headers={"X-Waiting-Room-Required": "true"},
            )

    # 1. Rate limiting
    client_id = str(cart_id)
    if not check_rate_limit(client_id, action="checkout", limit=get_settings().rate_limit_checkout_per_minute):
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail="Too many checkout requests. Please wait a moment.",
        )

    # 2. Check cart state
    cart = db.scalar(select(Cart).where(Cart.id == cart_id).with_for_update())
    if cart is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Cart not found")

    # Idempotent response if cart was already successfully checked out
    if cart.status is CartStatus.CHECKED_OUT:
        existing_order = db.scalar(select(Order).where(Order.cart_id == cart_id))
        if existing_order:
            existing_payment = db.scalar(select(Payment).where(Payment.order_id == existing_order.id))
            pay_ref = existing_payment.provider_reference if existing_payment else None
            return order_payload(existing_order, payment_reference=pay_ref)

    if cart.status is not CartStatus.ACTIVE:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Active cart not found")

    items = list(db.scalars(select(CartItem).where(CartItem.cart_id == cart_id)))
    if not items:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="A cart needs at least one item")

    # 3. Clean up expired holds inline so any freed stock is immediately accessible
    release_expired_reservations(db)

    # 4. Deterministic product sorting to prevent deadlocks under concurrent multi-item checkouts
    raw_product_ids = [item.product_id for item in items]
    sorted_product_ids = sorted(list(set(raw_product_ids)))

    # Fast-failure check via in-memory cache
    for item in items:
        stock_status = fast_reserve_stock(str(item.product_id), item.quantity)
        if stock_status == 0:
            raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Product is sold out")

    # Acquire locks in deterministic ascending order
    inventory_by_product = {
        row.product_id: row
        for row in db.scalars(
            select(Inventory)
            .where(Inventory.product_id.in_(sorted_product_ids))
            .order_by(Inventory.product_id)
            .with_for_update()
        )
    }
    products = {row.id: row for row in db.scalars(select(Product).where(Product.id.in_(sorted_product_ids)))}

    # 5. Check live flash sales
    now = datetime.now(UTC)
    live_sales = list(
        db.scalars(
            select(FlashSale).where(
                FlashSale.status == FlashSaleStatus.LIVE,
                FlashSale.starts_at <= now,
                FlashSale.ends_at > now,
            )
        )
    )

    flash_sale_map: dict[UUID, tuple[FlashSale, FlashSaleProduct]] = {}
    if live_sales:
        live_sale_ids = [s.id for s in live_sales]
        fsp_rows = list(
            db.scalars(
                select(FlashSaleProduct).where(
                    FlashSaleProduct.flash_sale_id.in_(live_sale_ids),
                    FlashSaleProduct.product_id.in_(sorted_product_ids),
                )
            )
        )
        for fsp in fsp_rows:
            sale = next((s for s in live_sales if s.id == fsp.flash_sale_id), None)
            if sale:
                flash_sale_map[fsp.product_id] = (sale, fsp)

    # 6. Verify inventory availability, per-customer limits, and flash sale allocations
    item_prices: dict[UUID, int] = {}
    for item in items:
        product = products.get(item.product_id)
        inventory = inventory_by_product.get(item.product_id)
        if product is None or inventory is None:
            raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Product or inventory unavailable")

        available_stock = inventory.on_hand_quantity - inventory.reserved_quantity
        if available_stock < item.quantity:
            raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=f"{product.name} is no longer available")

        # Flash sale rules
        if item.product_id in flash_sale_map:
            sale, fsp = flash_sale_map[item.product_id]
            # Per customer limit
            if cart.user_id:
                user_purchased = (
                    db.scalar(
                        select(func.coalesce(func.sum(OrderItem.quantity), 0))
                        .join(Order, Order.id == OrderItem.order_id)
                        .where(
                            Order.user_id == cart.user_id,
                            OrderItem.product_id == item.product_id,
                            Order.status.in_([OrderStatus.PAID, OrderStatus.PENDING_PAYMENT]),
                        )
                    )
                    or 0
                )
                if user_purchased + item.quantity > fsp.per_customer_limit:
                    raise HTTPException(
                        status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                        detail=f"Exceeds flash sale limit of {fsp.per_customer_limit} per customer for {product.name}",
                    )

            # Allocation limit check
            allocated_reserved = (
                db.scalar(
                    select(func.coalesce(func.sum(InventoryReservation.quantity), 0)).where(
                        InventoryReservation.flash_sale_id == sale.id,
                        InventoryReservation.product_id == item.product_id,
                        InventoryReservation.status.in_([ReservationStatus.ACTIVE, ReservationStatus.COMMITTED]),
                    )
                )
                or 0
            )
            if allocated_reserved + item.quantity > fsp.allocation_quantity:
                raise HTTPException(
                    status_code=status.HTTP_409_CONFLICT,
                    detail=f"{product.name} flash sale allocation is sold out",
                )
            item_prices[item.product_id] = fsp.sale_price_cents
        else:
            item_prices[item.product_id] = product.price_cents

    # 7. Create Order & Reservations
    subtotal = sum(products[item.product_id].price_cents * item.quantity for item in items)
    actual_total = sum(item_prices[item.product_id] * item.quantity for item in items)
    discount = max(0, subtotal - actual_total)
    expiry = now + timedelta(minutes=get_settings().reservation_window_minutes)

    order = Order(
        order_number=f"SC-{now:%Y%m%d}-{uuid.uuid4().hex[:7].upper()}",
        cart_id=cart.id,
        user_id=cart.user_id,
        subtotal_cents=subtotal,
        discount_cents=discount,
        total_cents=actual_total,
        currency="USD",
        status=OrderStatus.PENDING_PAYMENT,
    )
    db.add(order)
    db.flush()

    for item in items:
        product = products[item.product_id]
        inventory = inventory_by_product[item.product_id]
        inventory.reserved_quantity += item.quantity
        unit_price = item_prices[item.product_id]
        flash_sale_id = flash_sale_map[item.product_id][0].id if item.product_id in flash_sale_map else None

        db.add(
            OrderItem(
                order_id=order.id,
                product_id=product.id,
                product_sku=product.sku,
                product_name=product.name,
                unit_price_cents=unit_price,
                quantity=item.quantity,
                line_total_cents=unit_price * item.quantity,
            )
        )
        db.add(
            InventoryReservation(
                product_id=product.id,
                flash_sale_id=flash_sale_id,
                cart_id=cart.id,
                order_id=order.id,
                quantity=item.quantity,
                status=ReservationStatus.ACTIVE,
                expires_at=expiry,
            )
        )
        db.add(
            InventoryMovement(
                product_id=product.id,
                movement_type=InventoryMovementType.RESERVE,
                quantity_delta=-item.quantity,
                reference_type="order",
                reference_id=order.id,
                idempotency_key=f"reserve:{order.id}:{product.id}",
            )
        )
        # Update Redis in-memory available stock cache
        new_available = max(0, inventory.on_hand_quantity - inventory.reserved_quantity)
        set_product_stock_cache(str(product.id), new_available)

    payment = Payment(
        order_id=order.id,
        provider="demo",
        provider_reference=f"demo_{uuid.uuid4().hex}",
        status=PaymentStatus.PENDING,
        amount_cents=order.total_cents,
        currency=order.currency,
    )
    cart.status = CartStatus.CHECKED_OUT
    db.add(payment)
    payload = order_payload(order, payment_reference=payment.provider_reference, reservation_expires_at=expiry)
    db.commit()

    return payload


@router.post("/{order_id}/pay")
def confirm_demo_payment(order_id: UUID, db: Annotated[Session, Depends(get_db)]) -> dict:
    """Demo-only payment confirmation with inventory finalization."""
    if not get_settings().demo_payments_enabled:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Demo payments are disabled")

    order = db.scalar(select(Order).where(Order.id == order_id).with_for_update())
    if order is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Order not found")

    payment = db.scalar(select(Payment).where(Payment.order_id == order_id).with_for_update())
    if payment is None:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Payment record not found")

    if payment.status is PaymentStatus.PAID:
        return order_payload(order)

    reservations = list(
        db.scalars(
            select(InventoryReservation).where(
                InventoryReservation.order_id == order_id,
                InventoryReservation.status == ReservationStatus.ACTIVE,
            ).with_for_update()
        )
    )

    if not reservations or any(ensure_utc(row.expires_at) < datetime.now(UTC) for row in reservations):
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="The payment hold has expired")

    # Order product IDs to avoid deadlock
    sorted_product_ids = sorted(list(set(r.product_id for r in reservations)))
    inventory_rows = {
        row.product_id: row
        for row in db.scalars(
            select(Inventory)
            .where(Inventory.product_id.in_(sorted_product_ids))
            .order_by(Inventory.product_id)
            .with_for_update()
        )
    }

    for reservation in reservations:
        inventory = inventory_rows.get(reservation.product_id)
        if inventory is None:
            raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Inventory record missing")

        inventory.on_hand_quantity -= reservation.quantity
        inventory.reserved_quantity -= reservation.quantity
        reservation.status = ReservationStatus.COMMITTED
        db.add(
            InventoryMovement(
                product_id=reservation.product_id,
                movement_type=InventoryMovementType.COMMIT,
                quantity_delta=-reservation.quantity,
                reference_type="order",
                reference_id=order.id,
                idempotency_key=f"commit:{order.id}:{reservation.product_id}",
            )
        )
        new_available = max(0, inventory.on_hand_quantity - inventory.reserved_quantity)
        set_product_stock_cache(str(reservation.product_id), new_available)

    payment.status = PaymentStatus.PAID
    order.status = OrderStatus.PAID
    payload = order_payload(order)
    db.commit()
    return payload
