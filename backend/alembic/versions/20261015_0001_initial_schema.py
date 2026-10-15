"""Create the SurgeCart commerce schema.

Revision ID: 20261015_0001
Revises:
Create Date: 2026-10-15
"""

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision = "20261015_0001"
down_revision = None
branch_labels = None
depends_on = None


def upgrade() -> None:
    user_role = postgresql.ENUM("customer", "admin", name="user_role")
    cart_status = postgresql.ENUM("active", "checked_out", "abandoned", "expired", name="cart_status")
    order_status = postgresql.ENUM("pending_payment", "paid", "fulfilled", "cancelled", "refunded", name="order_status")
    payment_status = postgresql.ENUM("pending", "paid", "failed", "refunded", name="payment_status")
    sale_status = postgresql.ENUM("draft", "scheduled", "live", "ended", "cancelled", name="flash_sale_status")
    movement_type = postgresql.ENUM("restock", "reserve", "release", "commit", "adjustment", name="inventory_movement_type")
    reservation_status = postgresql.ENUM("active", "committed", "released", "expired", name="reservation_status")
    for enum in (user_role, cart_status, order_status, payment_status, sale_status, movement_type, reservation_status):
        enum.create(op.get_bind(), checkfirst=True)

    op.create_table(
        "users",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("email", sa.String(320), nullable=False, unique=True),
        sa.Column("password_hash", sa.String(255), nullable=False),
        sa.Column("display_name", sa.String(120), nullable=False),
        sa.Column("role", postgresql.ENUM(name="user_role", create_type=False), nullable=False, server_default="customer"),
        sa.Column("is_active", sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.text("now()")),
    )
    op.create_table(
        "products",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("sku", sa.String(64), nullable=False, unique=True),
        sa.Column("name", sa.String(255), nullable=False),
        sa.Column("description", sa.Text(), nullable=True),
        sa.Column("price_cents", sa.Integer(), nullable=False),
        sa.Column("currency", sa.String(3), nullable=False, server_default="USD"),
        sa.Column("is_active", sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.text("now()")),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.text("now()")),
        sa.CheckConstraint("price_cents >= 0", name="ck_product_price_nonnegative"),
    )
    op.create_index("ix_products_sku", "products", ["sku"])
    op.create_table(
        "inventory",
        sa.Column("product_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("products.id", ondelete="CASCADE"), primary_key=True),
        sa.Column("on_hand_quantity", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("reserved_quantity", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.text("now()")),
        sa.CheckConstraint("on_hand_quantity >= 0", name="ck_inventory_on_hand_nonnegative"),
        sa.CheckConstraint("reserved_quantity >= 0", name="ck_inventory_reserved_nonnegative"),
        sa.CheckConstraint("reserved_quantity <= on_hand_quantity", name="ck_inventory_reserved_lte_on_hand"),
    )
    op.create_table(
        "inventory_movements",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("product_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("products.id", ondelete="RESTRICT"), nullable=False),
        sa.Column("movement_type", postgresql.ENUM(name="inventory_movement_type", create_type=False), nullable=False),
        sa.Column("quantity_delta", sa.Integer(), nullable=False),
        sa.Column("reference_type", sa.String(50), nullable=True),
        sa.Column("reference_id", postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column("idempotency_key", sa.String(255), nullable=False, unique=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.text("now()")),
        sa.CheckConstraint("quantity_delta <> 0", name="ck_inventory_movement_nonzero"),
    )
    op.create_index("ix_inventory_movements_product_id", "inventory_movements", ["product_id"])
    op.create_table(
        "flash_sales",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("name", sa.String(255), nullable=False),
        sa.Column("status", postgresql.ENUM(name="flash_sale_status", create_type=False), nullable=False, server_default="draft"),
        sa.Column("starts_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("ends_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.text("now()")),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.text("now()")),
        sa.CheckConstraint("ends_at > starts_at", name="ck_flash_sale_valid_window"),
    )
    op.create_index("ix_flash_sales_starts_at", "flash_sales", ["starts_at"])
    op.create_index("ix_flash_sales_ends_at", "flash_sales", ["ends_at"])
    op.create_table(
        "flash_sale_products",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("flash_sale_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("flash_sales.id", ondelete="CASCADE"), nullable=False),
        sa.Column("product_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("products.id", ondelete="RESTRICT"), nullable=False),
        sa.Column("sale_price_cents", sa.Integer(), nullable=False),
        sa.Column("allocation_quantity", sa.Integer(), nullable=False),
        sa.Column("per_customer_limit", sa.Integer(), nullable=False, server_default="1"),
        sa.UniqueConstraint("flash_sale_id", "product_id", name="uq_flash_sale_product"),
        sa.CheckConstraint("sale_price_cents >= 0", name="ck_flash_sale_price_nonnegative"),
        sa.CheckConstraint("allocation_quantity > 0", name="ck_flash_sale_allocation_positive"),
        sa.CheckConstraint("per_customer_limit > 0", name="ck_flash_sale_customer_limit_positive"),
    )
    op.create_index("ix_flash_sale_products_flash_sale_id", "flash_sale_products", ["flash_sale_id"])
    op.create_index("ix_flash_sale_products_product_id", "flash_sale_products", ["product_id"])
    op.create_table(
        "carts",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("user_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("users.id", ondelete="SET NULL"), nullable=True),
        sa.Column("session_id", sa.String(255), nullable=True),
        sa.Column("status", postgresql.ENUM(name="cart_status", create_type=False), nullable=False, server_default="active"),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.text("now()")),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.text("now()")),
        sa.CheckConstraint("user_id IS NOT NULL OR session_id IS NOT NULL", name="ck_cart_owner_present"),
    )
    op.create_index("ix_carts_user_id", "carts", ["user_id"])
    op.create_index("ix_carts_session_id", "carts", ["session_id"])
    op.create_table(
        "cart_items",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("cart_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("carts.id", ondelete="CASCADE"), nullable=False),
        sa.Column("product_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("products.id", ondelete="RESTRICT"), nullable=False),
        sa.Column("flash_sale_product_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("flash_sale_products.id", ondelete="SET NULL"), nullable=True),
        sa.Column("quantity", sa.Integer(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.text("now()")),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.text("now()")),
        sa.UniqueConstraint("cart_id", "product_id", name="uq_cart_item_product"),
        sa.CheckConstraint("quantity > 0", name="ck_cart_item_quantity_positive"),
    )
    op.create_index("ix_cart_items_cart_id", "cart_items", ["cart_id"])
    op.create_index("ix_cart_items_product_id", "cart_items", ["product_id"])
    op.create_table(
        "orders",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("order_number", sa.String(32), nullable=False, unique=True),
        sa.Column("cart_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("carts.id", ondelete="SET NULL"), nullable=True),
        sa.Column("user_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("users.id", ondelete="SET NULL"), nullable=True),
        sa.Column("status", postgresql.ENUM(name="order_status", create_type=False), nullable=False, server_default="pending_payment"),
        sa.Column("currency", sa.String(3), nullable=False, server_default="USD"),
        sa.Column("subtotal_cents", sa.Integer(), nullable=False),
        sa.Column("discount_cents", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("total_cents", sa.Integer(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.text("now()")),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.text("now()")),
        sa.CheckConstraint("subtotal_cents >= 0", name="ck_order_subtotal_nonnegative"),
        sa.CheckConstraint("discount_cents >= 0", name="ck_order_discount_nonnegative"),
        sa.CheckConstraint("total_cents >= 0", name="ck_order_total_nonnegative"),
    )
    op.create_index("ix_orders_order_number", "orders", ["order_number"])
    op.create_index("ix_orders_user_id", "orders", ["user_id"])
    op.create_table(
        "order_items",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("order_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("orders.id", ondelete="CASCADE"), nullable=False),
        sa.Column("product_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("products.id", ondelete="RESTRICT"), nullable=False),
        sa.Column("product_sku", sa.String(64), nullable=False),
        sa.Column("product_name", sa.String(255), nullable=False),
        sa.Column("unit_price_cents", sa.Integer(), nullable=False),
        sa.Column("quantity", sa.Integer(), nullable=False),
        sa.Column("line_total_cents", sa.Integer(), nullable=False),
        sa.UniqueConstraint("order_id", "product_id", name="uq_order_item_product"),
        sa.CheckConstraint("quantity > 0", name="ck_order_item_quantity_positive"),
        sa.CheckConstraint("unit_price_cents >= 0", name="ck_order_item_unit_price_nonnegative"),
        sa.CheckConstraint("line_total_cents >= 0", name="ck_order_item_total_nonnegative"),
    )
    op.create_index("ix_order_items_order_id", "order_items", ["order_id"])
    op.create_index("ix_order_items_product_id", "order_items", ["product_id"])
    op.create_table(
        "payments",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("order_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("orders.id", ondelete="RESTRICT"), nullable=False, unique=True),
        sa.Column("provider", sa.String(32), nullable=False, server_default="demo"),
        sa.Column("provider_reference", sa.String(255), nullable=False, unique=True),
        sa.Column("status", postgresql.ENUM(name="payment_status", create_type=False), nullable=False, server_default="pending"),
        sa.Column("amount_cents", sa.Integer(), nullable=False),
        sa.Column("currency", sa.String(3), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.text("now()")),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.text("now()")),
        sa.CheckConstraint("amount_cents >= 0", name="ck_payment_amount_nonnegative"),
    )
    op.create_table(
        "inventory_reservations",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("product_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("products.id", ondelete="RESTRICT"), nullable=False),
        sa.Column("flash_sale_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("flash_sales.id", ondelete="SET NULL"), nullable=True),
        sa.Column("cart_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("carts.id", ondelete="SET NULL"), nullable=True),
        sa.Column("order_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("orders.id", ondelete="SET NULL"), nullable=True),
        sa.Column("quantity", sa.Integer(), nullable=False),
        sa.Column("status", postgresql.ENUM(name="reservation_status", create_type=False), nullable=False),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.text("now()")),
        sa.CheckConstraint("quantity > 0", name="ck_reservation_quantity_positive"),
        sa.CheckConstraint("cart_id IS NOT NULL OR order_id IS NOT NULL", name="ck_reservation_owner_present"),
    )
    op.create_index("ix_inventory_reservations_product_id", "inventory_reservations", ["product_id"])
    op.create_index("ix_inventory_reservations_expires_at", "inventory_reservations", ["expires_at"])


def downgrade() -> None:
    for table in ("inventory_reservations", "payments", "order_items", "orders", "cart_items", "carts", "flash_sale_products", "flash_sales", "inventory_movements", "inventory", "products", "users"):
        op.drop_table(table)
    for name in ("reservation_status", "inventory_movement_type", "flash_sale_status", "payment_status", "order_status", "cart_status", "user_role"):
        postgresql.ENUM(name=name).drop(op.get_bind(), checkfirst=True)
