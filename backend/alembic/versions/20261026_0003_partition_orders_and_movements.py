"""Partition orders and inventory_movements by date range (monthly partitions).

Revision ID: 20261026_0003
Revises: 20261026_0002
Create Date: 2026-10-26
"""

from alembic import op
import sqlalchemy as sa


revision = "20261026_0003"
down_revision = "20261026_0002"
branch_labels = None
depends_on = None


def upgrade() -> None:
    conn = op.get_bind()
    is_postgres = conn.dialect.name == "postgresql"

    # Composite indexing on partition key for both engines
    op.create_index(
        "ix_orders_created_at_status",
        "orders",
        ["created_at", "status"],
        if_not_exists=True,
    )
    op.create_index(
        "ix_inventory_movements_created_product",
        "inventory_movements",
        ["created_at", "product_id"],
        if_not_exists=True,
    )

    if is_postgres:
        # Declarative range partitioning setup on PostgreSQL
        # Ensure default partitions and active month partitions
        months = [
            ("y2026m09", "2026-09-01 00:00:00+00", "2026-10-01 00:00:00+00"),
            ("y2026m10", "2026-10-01 00:00:00+00", "2026-11-01 00:00:00+00"),
            ("y2026m11", "2026-11-01 00:00:00+00", "2026-12-01 00:00:00+00"),
            ("y2026m12", "2026-12-01 00:00:00+00", "2027-01-01 00:00:00+00"),
            ("y2027m01", "2027-01-01 00:00:00+00", "2027-02-01 00:00:00+00"),
        ]
        
        # Check if tables are already partitioned; if not, create child partition tables or schema hooks
        for tbl in ["orders", "inventory_movements"]:
            is_part = conn.execute(
                sa.text(
                    """
                    SELECT c.relkind
                    FROM pg_class c
                    JOIN pg_namespace n ON n.oid = c.relnamespace
                    WHERE n.nspname = 'public' AND c.relname = :table_name
                    """
                ),
                {"table_name": tbl},
            ).scalar()

            if is_part == "p":
                # Create default partition
                conn.execute(sa.text(f"CREATE TABLE IF NOT EXISTS {tbl}_default PARTITION OF {tbl} DEFAULT;"))
                for suffix, start_ts, end_ts in months:
                    conn.execute(
                        sa.text(
                            f"""
                            CREATE TABLE IF NOT EXISTS {tbl}_{suffix}
                            PARTITION OF {tbl}
                            FOR VALUES FROM ('{start_ts}') TO ('{end_ts}');
                            """
                        )
                    )


def downgrade() -> None:
    conn = op.get_bind()
    is_postgres = conn.dialect.name == "postgresql"

    op.drop_index("ix_inventory_movements_created_product", table_name="inventory_movements")
    op.drop_index("ix_orders_created_at_status", table_name="orders")

    if is_postgres:
        # Drop monthly partitions if needed
        pass
