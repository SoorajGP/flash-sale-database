"""Create a local administrator and three storefront products.

Run after `alembic upgrade head` with: `python -m app.seed`.
"""

from sqlalchemy import select

from app.core.security import hash_password
from app.db.session import SessionLocal
from app.modules.catalog.models import Product
from app.modules.inventory.models import Inventory, InventoryMovement, InventoryMovementType
from app.modules.users.models import User, UserRole


PRODUCTS = [
    ("TRANSIT-RUNNER", "Transit Runner", "A lightweight, everyday runner.", 12900, 150),
    ("PULSE-MINI", "Pulse Mini", "A portable speaker for everywhere.", 7900, 80),
    ("WEEKENDER-02", "Weekender 02", "A structured carry-all for weekends away.", 9800, 55),
]


def main() -> None:
    with SessionLocal.begin() as db:
        admin = db.scalar(select(User).where(User.email == "admin@surgecart.local"))
        if admin is None:
            db.add(User(email="admin@surgecart.local", display_name="SurgeCart Admin",
                        password_hash=hash_password("change-this-password"), role=UserRole.ADMIN))
        for sku, name, description, price_cents, stock in PRODUCTS:
            if db.scalar(select(Product.id).where(Product.sku == sku)):
                continue
            product = Product(sku=sku, name=name, description=description, price_cents=price_cents)
            db.add(product)
            db.flush()
            db.add(Inventory(product_id=product.id, on_hand_quantity=stock))
            db.add(InventoryMovement(product_id=product.id, movement_type=InventoryMovementType.RESTOCK,
                                     quantity_delta=stock, reference_type="seed", reference_id=product.id,
                                     idempotency_key=f"seed:{product.id}"))
    print("Seeded admin@surgecart.local and storefront products.")


if __name__ == "__main__":
    main()
