"""Add catalog extensions and product feedback table.

Revision ID: 20261026_0002
Revises: 20261015_0001
Create Date: 2026-10-26
"""

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision = "20261026_0002"
down_revision = "20261015_0001"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # ── 1. Extend products table with partner, gallery, dimensions, weight, and taxonomy ──
    op.add_column("products", sa.Column("vendor_id", sa.String(length=64), nullable=True))
    op.create_index("ix_products_vendor_id", "products", ["vendor_id"])

    op.add_column("products", sa.Column("vendor_name", sa.String(length=255), nullable=True))
    op.create_index("ix_products_vendor_name", "products", ["vendor_name"])

    op.add_column(
        "products",
        sa.Column(
            "media_gallery",
            postgresql.JSONB(astext_type=sa.Text()),
            nullable=False,
            server_default=sa.text("'[]'::jsonb"),
        ),
    )
    op.add_column(
        "products",
        sa.Column(
            "dimensions",
            postgresql.JSONB(astext_type=sa.Text()),
            nullable=True,
        ),
    )
    op.add_column("products", sa.Column("weight", sa.Float(), nullable=True))

    op.add_column("products", sa.Column("category_path", sa.String(length=255), nullable=True))
    op.create_index("ix_products_category_path", "products", ["category_path"])

    # ── 2. Create product_feedback table with constraints & relationships ──
    op.create_table(
        "product_feedback",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column(
            "product_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("products.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "user_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("users.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("rating_score", sa.Integer(), nullable=False),
        sa.Column("headline", sa.String(length=255), nullable=False),
        sa.Column("body_text", sa.Text(), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
        sa.CheckConstraint(
            "rating_score >= 1 AND rating_score <= 5",
            name="ck_product_feedback_rating_range",
        ),
        sa.UniqueConstraint(
            "product_id",
            "user_id",
            name="uq_product_feedback_product_user",
        ),
    )
    op.create_index("ix_product_feedback_product_id", "product_feedback", ["product_id"])
    op.create_index("ix_product_feedback_user_id", "product_feedback", ["user_id"])


def downgrade() -> None:
    op.drop_index("ix_product_feedback_user_id", table_name="product_feedback")
    op.drop_index("ix_product_feedback_product_id", table_name="product_feedback")
    op.drop_table("product_feedback")

    op.drop_index("ix_products_category_path", table_name="products")
    op.drop_column("products", "category_path")
    op.drop_column("products", "weight")
    op.drop_column("products", "dimensions")
    op.drop_column("products", "media_gallery")
    op.drop_index("ix_products_vendor_name", table_name="products")
    op.drop_column("products", "vendor_name")
    op.drop_index("ix_products_vendor_id", table_name="products")
    op.drop_column("products", "vendor_id")
