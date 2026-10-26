"""Import all SQLAlchemy models so Alembic can discover a complete metadata set."""

from app.modules.catalog.models import Product, ProductFeedback
from app.modules.carts.models import Cart, CartItem
from app.modules.inventory.models import Inventory, InventoryMovement, InventoryReservation
from app.modules.orders.models import Order, OrderItem
from app.modules.payments.models import Payment
from app.modules.sales.models import FlashSale, FlashSaleProduct
from app.modules.users.models import User
from app.modules.waitlist.models import FlashSaleWaitlist

__all__ = [
    "Cart", "CartItem", "FlashSale", "FlashSaleProduct", "FlashSaleWaitlist", "Inventory",
    "InventoryMovement", "InventoryReservation", "Order", "OrderItem", "Payment", "Product", "ProductFeedback", "User",
]
