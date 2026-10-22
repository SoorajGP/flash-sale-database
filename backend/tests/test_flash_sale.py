from datetime import UTC, datetime, timedelta
import uuid
from fastapi.testclient import TestClient
import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import Session, sessionmaker

from app.core.config import get_settings
from app.db.base import Base
import app.db.models  # noqa: F401 - Register all models in Base.metadata
from app.db.session import get_db
from app.main import create_app
from app.modules.carts.models import Cart, CartItem, CartStatus
from app.modules.catalog.models import Product
from app.modules.inventory.models import (
    Inventory,
    InventoryReservation,
    ReservationStatus,
)
from app.modules.inventory.service import release_expired_reservations
from app.modules.orders.models import OrderStatus
from app.modules.sales.models import FlashSale, FlashSaleProduct, FlashSaleStatus
from app.modules.users.models import User, UserRole

# Use SQLite in-memory for testing logic without requiring running PostgreSQL
TEST_DB_URL = "sqlite:///:memory:"


@pytest.fixture
def test_db():
    engine = create_engine(TEST_DB_URL, connect_args={"check_same_thread": False})
    Base.metadata.create_all(bind=engine)
    TestingSessionLocal = sessionmaker(bind=engine, autocommit=False, autoflush=False)
    db = TestingSessionLocal()
    try:
        yield db
    finally:
        db.close()
        Base.metadata.drop_all(bind=engine)


@pytest.fixture
def client(test_db: Session):
    app = create_app()

    def override_get_db():
        try:
            yield test_db
        finally:
            pass

    app.dependency_overrides[get_db] = override_get_db
    with TestClient(app) as test_client:
        yield test_client
    app.dependency_overrides.clear()


def test_system_time(client: TestClient) -> None:
    res = client.get("/api/v1/system/time")
    assert res.status_code == 200
    data = res.json()
    assert "server_time" in data
    assert "redis_available" in data


def test_release_expired_reservations(test_db: Session) -> None:
    now = datetime.now(UTC)
    product = Product(sku="PROD-TEST-1", name="Test Product", price_cents=5000, currency="USD")
    test_db.add(product)
    test_db.flush()

    inventory = Inventory(product_id=product.id, on_hand_quantity=10, reserved_quantity=3)
    test_db.add(inventory)

    # 1 expired reservation
    expired_res = InventoryReservation(
        product_id=product.id,
        quantity=2,
        status=ReservationStatus.ACTIVE,
        expires_at=now - timedelta(minutes=5),
    )
    # 1 still active reservation
    active_res = InventoryReservation(
        product_id=product.id,
        quantity=1,
        status=ReservationStatus.ACTIVE,
        expires_at=now + timedelta(minutes=5),
    )
    test_db.add_all([expired_res, active_res])
    test_db.commit()

    # Run release
    released = release_expired_reservations(test_db)
    assert released == 1

    test_db.refresh(inventory)
    test_db.refresh(expired_res)
    test_db.refresh(active_res)

    # Reserved quantity should decrease by 2 (from 3 to 1)
    assert inventory.reserved_quantity == 1
    assert expired_res.status == ReservationStatus.EXPIRED
    assert active_res.status == ReservationStatus.ACTIVE


def test_checkout_applies_flash_sale_pricing(test_db: Session, client: TestClient) -> None:
    now = datetime.now(UTC)
    # 1. Create product and inventory
    product = Product(sku="PROD-FS-1", name="Flash Sale Sneaker", price_cents=10000, currency="USD")
    test_db.add(product)
    test_db.flush()
    inventory = Inventory(product_id=product.id, on_hand_quantity=50, reserved_quantity=0)
    test_db.add(inventory)

    # 2. Create active flash sale with discount ($60 instead of $100)
    sale = FlashSale(
        name="Midnight Drop",
        status=FlashSaleStatus.LIVE,
        starts_at=now - timedelta(minutes=10),
        ends_at=now + timedelta(hours=1),
    )
    test_db.add(sale)
    test_db.flush()

    fsp = FlashSaleProduct(
        flash_sale_id=sale.id,
        product_id=product.id,
        sale_price_cents=6000,
        allocation_quantity=20,
        per_customer_limit=2,
    )
    test_db.add(fsp)

    # 3. Create Cart with item
    cart = Cart(session_id="test-session-123", status=CartStatus.ACTIVE)
    test_db.add(cart)
    test_db.flush()
    cart_item = CartItem(cart_id=cart.id, product_id=product.id, quantity=1)
    test_db.add(cart_item)
    test_db.commit()

    # 4. Perform checkout
    response = client.post(f"/api/v1/orders/checkout/{cart.id}")
    assert response.status_code == 201
    order_data = response.json()

    # Total should reflect flash sale price of $60 (6000 cents), not regular price $100
    assert order_data["total_cents"] == 6000
    assert order_data["discount_cents"] == 4000
    assert order_data["status"] == OrderStatus.PENDING_PAYMENT.value

    # 5. Idempotent retry with same cart should return existing order with 200/201 without creating duplicate
    retry_response = client.post(f"/api/v1/orders/checkout/{cart.id}")
    assert retry_response.status_code in (200, 201)
    assert retry_response.json()["order_number"] == order_data["order_number"]


def test_per_customer_limit_enforced(test_db: Session, client: TestClient) -> None:
    now = datetime.now(UTC)
    user = User(email="buyer@example.com", password_hash="hash", display_name="Buyer")
    product = Product(sku="PROD-LIMIT-1", name="Limited Drop Item", price_cents=8000, currency="USD")
    test_db.add_all([user, product])
    test_db.flush()

    inventory = Inventory(product_id=product.id, on_hand_quantity=10, reserved_quantity=0)
    test_db.add(inventory)

    sale = FlashSale(name="Strict Drop", status=FlashSaleStatus.LIVE, starts_at=now - timedelta(minutes=5), ends_at=now + timedelta(hours=1))
    test_db.add(sale)
    test_db.flush()

    fsp = FlashSaleProduct(flash_sale_id=sale.id, product_id=product.id, sale_price_cents=5000, allocation_quantity=10, per_customer_limit=1)
    test_db.add(fsp)

    # Cart with quantity = 2 exceeding per_customer_limit of 1
    cart = Cart(user_id=user.id, status=CartStatus.ACTIVE)
    test_db.add(cart)
    test_db.flush()
    test_db.add(CartItem(cart_id=cart.id, product_id=product.id, quantity=2))
    test_db.commit()

    res = client.post(f"/api/v1/orders/checkout/{cart.id}")
    assert res.status_code == 422
    assert "Exceeds flash sale limit" in res.json()["detail"]

