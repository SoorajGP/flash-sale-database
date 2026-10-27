import uuid
from fastapi.testclient import TestClient
import pytest
from sqlalchemy import create_engine, select
from sqlalchemy.orm import Session, sessionmaker

from app.core.security import require_admin
from app.db.base import Base
import app.db.models  # noqa: F401
from app.db.session import get_db
from app.main import create_app
from app.modules.catalog.models import Product
from app.modules.inventory.models import Inventory
from app.modules.orders.models import Order, OrderItem, OrderStatus
from app.modules.users.models import User, UserRole

from sqlalchemy.pool import StaticPool

TEST_DB_URL = "sqlite:///:memory:"


@pytest.fixture
def test_db():
    engine = create_engine(
        TEST_DB_URL,
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
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

    admin_user = User(
        id=uuid.uuid4(),
        email="admin@surgecart.internal",
        display_name="Admin",
        role=UserRole.ADMIN,
        is_active=True,
    )

    def override_get_db():
        yield test_db

    def override_require_admin():
        return admin_user

    app.dependency_overrides[get_db] = override_get_db
    app.dependency_overrides[require_admin] = override_require_admin
    with TestClient(app) as test_client:
        yield test_client
    app.dependency_overrides.clear()


def test_delete_product_success(test_db: Session, client: TestClient):
    # 1. Create product and inventory
    product = Product(
        sku="DEL-PROD-1",
        name="Item to Delete",
        price_cents=4500,
        currency="INR",
        is_active=True,
    )
    test_db.add(product)
    test_db.flush()

    inventory = Inventory(product_id=product.id, on_hand_quantity=25)
    test_db.add(inventory)
    test_db.commit()

    # Verify present in admin listing
    res = client.get("/api/v1/admin/products")
    assert res.status_code == 200
    assert any(p["sku"] == "DEL-PROD-1" for p in res.json())

    # 2. Delete the product
    del_res = client.delete(f"/api/v1/admin/products/{product.id}")
    assert del_res.status_code == 200
    data = del_res.json()
    assert data["success"] is True
    assert data["mode"] == "deleted"

    # Verify absent from database
    assert test_db.scalar(select(Product).where(Product.id == product.id)) is None
    assert test_db.scalar(select(Inventory).where(Inventory.product_id == product.id)) is None

    # Verify absent from admin product listing
    res_after = client.get("/api/v1/admin/products")
    assert res_after.status_code == 200
    assert not any(p["sku"] == "DEL-PROD-1" for p in res_after.json())


def test_delete_product_with_orders_archives_product(test_db: Session, client: TestClient):
    # 1. Create product, inventory, and order item
    product = Product(
        sku="ORDERED-ITEM",
        name="Product with Order",
        price_cents=7500,
        currency="INR",
        is_active=True,
    )
    test_db.add(product)
    test_db.flush()

    inventory = Inventory(product_id=product.id, on_hand_quantity=10)
    test_db.add(inventory)
    test_db.flush()

    order = Order(
        order_number="SC-TEST-001",
        subtotal_cents=7500,
        discount_cents=0,
        total_cents=7500,
        currency="INR",
        status=OrderStatus.PAID,
    )
    test_db.add(order)
    test_db.flush()

    order_item = OrderItem(
        order_id=order.id,
        product_id=product.id,
        product_sku=product.sku,
        product_name=product.name,
        unit_price_cents=7500,
        quantity=1,
        line_total_cents=7500,
    )
    test_db.add(order_item)
    test_db.commit()

    # 2. Delete without force
    del_res = client.delete(f"/api/v1/admin/products/{product.id}")
    assert del_res.status_code == 200
    data = del_res.json()
    assert data["success"] is True
    assert data["mode"] == "archived"

    # Verify product is deactivated and removed from active listing
    test_db.refresh(product)
    assert product.is_active is False

    res_active = client.get("/api/v1/admin/products")
    assert not any(p["sku"] == "ORDERED-ITEM" for p in res_active.json())


def test_delete_nonexistent_product_returns_404(test_db: Session, client: TestClient):
    non_existent_id = uuid.uuid4()
    res = client.delete(f"/api/v1/admin/products/{non_existent_id}")
    assert res.status_code == 404
