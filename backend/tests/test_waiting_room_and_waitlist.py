from __future__ import annotations

import time
import uuid
from datetime import UTC, datetime, timedelta

from fastapi.testclient import TestClient
from sqlalchemy import select

from app.db.session import SessionLocal
from app.main import app
from app.modules.carts.models import Cart
from app.modules.catalog.models import Product
from app.modules.inventory.models import (
    Inventory,
    InventoryMovement,
    InventoryMovementType,
    InventoryReservation,
    ReservationStatus,
)
from app.modules.inventory.service import release_expired_reservations
from app.modules.waiting_room.service import (
    admit_next_batch,
    get_ticket_status,
    issue_ticket,
    set_waiting_room_active,
)
from app.modules.waitlist.models import FlashSaleWaitlist, WaitlistStatus
from app.modules.waitlist.service import (
    claim_waitlist_stock,
    get_user_restock_alerts,
    join_waitlist,
    process_restock_alerts_for_product,
)

client = TestClient(app)


def test_waiting_room_ticket_issue_and_leaky_bucket_admission():
    set_waiting_room_active(True)
    try:
        cart_1 = str(uuid.uuid4())
        cart_2 = str(uuid.uuid4())

        t1 = issue_ticket(cart_id=cart_1)
        t2 = issue_ticket(cart_id=cart_2)

        assert t1["ticket_id"].startswith("TKT-")
        assert t2["ticket_id"].startswith("TKT-")
        assert t2["queue_number"] > t1["queue_number"]
        assert t1["status"] == "WAITING"

        # Check status endpoint
        res = client.get(f"/api/v1/waiting-room/status/{t1['ticket_id']}")
        assert res.status_code == 200
        assert res.json()["status"] == "WAITING"

        # Admit batch via leaky bucket discharge
        admitted = admit_next_batch(count=10)
        assert admitted >= 2

        # Check status after admission
        res = client.get(f"/api/v1/waiting-room/status/{t1['ticket_id']}")
        assert res.status_code == 200
        data = res.json()
        assert data["status"] == "ADMITTED"
        assert data["admission_token"] is not None
        assert len(data["admission_token"]) > 10
    finally:
        set_waiting_room_active(False)


def test_checkout_waiting_room_gate():
    # When waiting room is active, checkout without token returns 429
    set_waiting_room_active(True)
    try:
        # Create a cart
        cart_res = client.post("/api/v1/carts", json={})
        cart_id = cart_res.json()["id"]

        # Attempt checkout directly without token
        chk_res = client.post(f"/api/v1/orders/checkout/{cart_id}")
        assert chk_res.status_code == 429
        assert "Virtual waiting room active" in chk_res.json()["detail"]

        # Now issue ticket and admit
        ticket = issue_ticket(cart_id=cart_id)
        admit_next_batch(count=10)
        status_info = get_ticket_status(ticket["ticket_id"])
        token = status_info["admission_token"]
        assert token is not None

        # Add item to cart first
        db = SessionLocal()
        try:
            prod = db.scalar(select(Product))
            assert prod is not None
        finally:
            db.close()

        client.post(
            f"/api/v1/carts/{cart_id}/items",
            json={"product_id": str(prod.id), "quantity": 1},
        )

        # Checkout with valid admission token
        chk_res = client.post(
            f"/api/v1/orders/checkout/{cart_id}",
            headers={"X-Queue-Admission-Token": token},
        )
        assert chk_res.status_code == 201

        # Second attempt with same token must be rejected (token already consumed)
        chk_res_2 = client.post(
            f"/api/v1/orders/checkout/{cart_id}",
            headers={"X-Queue-Admission-Token": token},
        )
        assert chk_res_2.status_code == 429
    finally:
        set_waiting_room_active(False)


def test_automated_waitlist_and_restock_alert_on_expired_hold():
    db = SessionLocal()
    try:
        prod = db.scalar(select(Product))
        assert prod is not None

        # Clean any prior waitlist entries for test product to test FIFO from position 1
        from sqlalchemy import delete
        db.execute(delete(FlashSaleWaitlist).where(FlashSaleWaitlist.product_id == prod.id))
        db.commit()

        # 1. Join waitlist
        test_email = f"shopper_{uuid.uuid4().hex[:6]}@example.com"
        entry_data = join_waitlist(db, product_id=prod.id, email=test_email)
        assert entry_data["status"] == "pending"
        assert entry_data["position"] == 1

        # 2. Duplicate join returns existing position
        dup = join_waitlist(db, product_id=prod.id, email=test_email)
        assert dup["already_joined"] is True
        assert dup["position"] == entry_data["position"]

        # 3. Simulate an expired reservation hold (10-minute hold that expired unpurchased)
        test_cart = Cart(session_id=f"sess_{uuid.uuid4().hex[:12]}")
        db.add(test_cart)
        db.flush()

        now = datetime.now(UTC)
        past_expired = now - timedelta(minutes=15)
        expired_res = InventoryReservation(
            product_id=prod.id,
            cart_id=test_cart.id,
            quantity=1,
            status=ReservationStatus.ACTIVE,
            expires_at=past_expired,
        )
        db.add(expired_res)
        db.commit()

        # 4. Trigger release_expired_reservations (which releases the hold and fires restock alerts)
        released = release_expired_reservations(db)
        assert released >= 1

        # 5. Verify the waitlisted customer received an automated restock alert
        alerts = get_user_restock_alerts(db, email=test_email)
        assert len(alerts) >= 1
        alert = alerts[0]
        assert alert["product_id"] == str(prod.id)
        assert alert["claim_token"] is not None
        assert alert["remaining_seconds"] > 0

        # 6. Customer claims restocked unit
        claim_res = claim_waitlist_stock(db, claim_token=alert["claim_token"])
        assert claim_res["status"] == "claimed"

        # Verify status in database
        updated_entry = db.get(FlashSaleWaitlist, uuid.UUID(entry_data["waitlist_id"]))
        assert updated_entry.status == WaitlistStatus.CLAIMED
    finally:
        db.close()
