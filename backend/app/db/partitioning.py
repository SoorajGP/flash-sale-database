"""
Table Partitioning Manager for High-Volume Flash Sale Orders & Inventory Movements
===================================================================================
Provides native PostgreSQL range partitioning by date range (monthly partitions)
for high-velocity tables:
  1. `orders`: Partitioned by `RANGE (created_at)`
  2. `inventory_movements`: Partitioned by `RANGE (created_at)`

Ensures:
- Queries targeting active flash sales scan only the latest monthly partition,
  significantly reducing B-Tree index traversal depth, buffer cache churn, and disk I/O.
- Automatic creation and maintenance of upcoming partitions.
- Transparent fallback and mock partition metrics for local development on SQLite.
"""
from __future__ import annotations

from datetime import UTC, datetime
import logging
from typing import Any
from sqlalchemy import text
from sqlalchemy.engine import Engine
from sqlalchemy.orm import Session

logger = logging.getLogger("surgecart.partitioning")

PARTITIONED_TABLES = ("orders", "inventory_movements")


def add_months(year: int, month: int, delta: int) -> tuple[int, int]:
    """Pure standard-library month addition."""
    total_months = year * 12 + (month - 1) + delta
    return total_months // 12, (total_months % 12) + 1


def get_month_partition_bounds(year: int, month: int) -> tuple[str, str, str]:
    """
    Returns (suffix, start_iso, end_iso) for a given year and month.
    Example for Oct 2026: ('y2026m10', '2026-10-01 00:00:00+00', '2026-11-01 00:00:00+00')
    """
    start_dt = datetime(year, month, 1, 0, 0, 0, tzinfo=UTC)
    next_y, next_m = add_months(year, month, 1)
    end_dt = datetime(next_y, next_m, 1, 0, 0, 0, tzinfo=UTC)
    suffix = f"y{year}m{month:02d}"
    return suffix, start_dt.strftime("%Y-%m-%d %H:%M:%S+00"), end_dt.strftime("%Y-%m-%d %H:%M:%S+00")


def ensure_date_partitions(engine: Engine, months_back: int = 2, months_forward: int = 6) -> list[str]:
    """
    Ensures that monthly partitions for `orders` and `inventory_movements`
    exist for the specified sliding window around the current UTC date.
    On PostgreSQL: executes declarative DDL to create table partitions if not present.
    On SQLite: safely skips partition DDL while recording active partition coverage.
    """
    is_postgres = engine.dialect.name == "postgresql"
    created_partitions: list[str] = []

    now = datetime.now(UTC)
    target_months: list[tuple[int, int]] = []
    for offset in range(-months_back, months_forward + 1):
        target_months.append(add_months(now.year, now.month, offset))

    if not is_postgres:
        logger.debug("Database is %s. Native table partitioning is active in PostgreSQL.", engine.dialect.name)
        return [f"{tbl}_y{y}m{m:02d}" for tbl in PARTITIONED_TABLES for y, m in target_months]

    with engine.begin() as conn:
        for tbl in PARTITIONED_TABLES:
            partitioned_check = conn.execute(
                text(
                    """
                    SELECT c.relkind
                    FROM pg_class c
                    JOIN pg_namespace n ON n.oid = c.relnamespace
                    WHERE n.nspname = 'public' AND c.relname = :table_name
                    """
                ),
                {"table_name": tbl},
            ).scalar()

            if partitioned_check == "r":
                logger.info("Upgrading table '%s' to native declarative range partitioning...", tbl)
                if tbl == "inventory_movements":
                    conn.execute(text("ALTER TABLE inventory_movements RENAME TO inventory_movements_old;"))
                    conn.execute(text("""
                        CREATE TABLE inventory_movements (
                            id UUID NOT NULL,
                            product_id UUID NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
                            movement_type inventory_movement_type NOT NULL,
                            quantity_delta INTEGER NOT NULL,
                            reference_type VARCHAR(50),
                            reference_id UUID,
                            idempotency_key VARCHAR(255) NOT NULL,
                            created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
                            PRIMARY KEY (id, created_at)
                        ) PARTITION BY RANGE (created_at);
                    """))
                    conn.execute(text("CREATE TABLE IF NOT EXISTS inventory_movements_default PARTITION OF inventory_movements DEFAULT;"))
                    conn.execute(text("INSERT INTO inventory_movements SELECT * FROM inventory_movements_old;"))
                    conn.execute(text("DROP TABLE inventory_movements_old;"))
                    partitioned_check = "p"
                elif tbl == "orders":
                    conn.execute(text("ALTER TABLE IF EXISTS order_items DROP CONSTRAINT IF EXISTS order_items_order_id_fkey;"))
                    conn.execute(text("ALTER TABLE IF EXISTS payments DROP CONSTRAINT IF EXISTS payments_order_id_fkey;"))
                    conn.execute(text("ALTER TABLE IF EXISTS inventory_reservations DROP CONSTRAINT IF EXISTS inventory_reservations_order_id_fkey;"))
                    conn.execute(text("ALTER TABLE orders RENAME TO orders_old;"))
                    conn.execute(text("""
                        CREATE TABLE orders (
                            id UUID NOT NULL,
                            order_number VARCHAR(32) NOT NULL,
                            cart_id UUID REFERENCES carts(id) ON DELETE SET NULL,
                            user_id UUID REFERENCES users(id) ON DELETE SET NULL,
                            status order_status NOT NULL DEFAULT 'pending_payment',
                            currency VARCHAR(3) NOT NULL DEFAULT 'INR',
                            subtotal_cents INTEGER NOT NULL,
                            discount_cents INTEGER NOT NULL DEFAULT 0,
                            total_cents INTEGER NOT NULL,
                            created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
                            updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
                            PRIMARY KEY (id, created_at)
                        ) PARTITION BY RANGE (created_at);
                    """))
                    conn.execute(text("CREATE TABLE IF NOT EXISTS orders_default PARTITION OF orders DEFAULT;"))
                    conn.execute(text("INSERT INTO orders SELECT * FROM orders_old;"))
                    conn.execute(text("DROP TABLE orders_old CASCADE;"))
                    conn.execute(text("CREATE INDEX IF NOT EXISTS ix_orders_order_number ON orders (order_number, created_at);"))
                    conn.execute(text("CREATE INDEX IF NOT EXISTS ix_orders_user_id ON orders (user_id, created_at);"))
                    conn.execute(text("CREATE INDEX IF NOT EXISTS ix_order_items_order_id ON order_items (order_id);"))
                    conn.execute(text("CREATE INDEX IF NOT EXISTS ix_payments_order_id ON payments (order_id);"))
                    conn.execute(text("CREATE INDEX IF NOT EXISTS ix_inventory_reservations_order_id ON inventory_reservations (order_id);"))
                    partitioned_check = "p"

            if partitioned_check != "p":
                logger.info("Table '%s' relkind is '%s' (not partitioned). Skipping partition DDL.", tbl, partitioned_check)
                continue

            default_part = f"{tbl}_default"
            conn.execute(
                text(f"CREATE TABLE IF NOT EXISTS {default_part} PARTITION OF {tbl} DEFAULT;")
            )

            existing_tables = set(conn.execute(text("SELECT relname FROM pg_class")).scalars())
            for year, month in target_months:
                suffix, start_val, end_val = get_month_partition_bounds(year, month)
                part_name = f"{tbl}_{suffix}"
                if part_name not in existing_tables:
                    ddl = f"""
                    CREATE TABLE IF NOT EXISTS {part_name}
                    PARTITION OF {tbl}
                    FOR VALUES FROM ('{start_val}') TO ('{end_val}');
                    """
                    conn.execute(text(ddl))
                created_partitions.append(part_name)

    logger.info("Verified monthly partitions for %s: %d partitions active.", PARTITIONED_TABLES, len(created_partitions))
    return created_partitions


def get_partition_info(db: Session) -> dict[str, Any]:
    """
    Returns live partition topology and metrics for orders and inventory_movements.
    For PostgreSQL: queries pg_inherits and pg_class to report actual partition sizes and bounds.
    For SQLite: returns current active partition schema metadata.
    """
    engine = db.get_bind()
    is_postgres = engine.dialect.name == "postgresql"
    now = datetime.now(UTC)
    current_suffix = f"y{now.year}m{now.month:02d}"

    if is_postgres:
        query = text(
            """
            SELECT
                nmsp_parent.nspname AS parent_schema,
                parent.relname      AS parent_table,
                child.relname       AS partition_name,
                pg_get_expr(child.relpartbound, child.oid) AS partition_expression,
                pg_total_relation_size(child.oid) AS total_bytes,
                COALESCE(child.reltuples::bigint, 0) AS estimated_rows
            FROM pg_inherits
            JOIN pg_class parent        ON pg_inherits.inhparent = parent.oid
            JOIN pg_class child         ON pg_inherits.inhrelid   = child.oid
            JOIN pg_namespace nmsp_parent ON nmsp_parent.oid = parent.relnamespace
            WHERE parent.relname IN ('orders', 'inventory_movements')
            ORDER BY parent.relname, child.relname;
            """
        )
        rows = db.execute(query).fetchall()
        partitions_by_table: dict[str, list[dict[str, Any]]] = {
            "orders": [],
            "inventory_movements": [],
        }
        for r in rows:
            table_name = r.parent_table
            if table_name in partitions_by_table:
                partitions_by_table[table_name].append(
                    {
                        "partition_name": r.partition_name,
                        "bound_expression": r.partition_expression,
                        "total_bytes": int(r.total_bytes),
                        "estimated_rows": int(r.estimated_rows),
                        "is_current": current_suffix in r.partition_name,
                    }
                )

        return {
            "engine": "postgresql",
            "partitioning_type": "range_by_date",
            "partition_key": "created_at",
            "current_partition_suffix": current_suffix,
            "partition_interval": "monthly",
            "tables": partitions_by_table,
        }

    simulated: dict[str, list[dict[str, Any]]] = {}
    for tbl in PARTITIONED_TABLES:
        simulated[tbl] = []
        for offset in [-1, 0, 1, 2]:
            py, pm = add_months(now.year, now.month, offset)
            suffix, start_b, end_b = get_month_partition_bounds(py, pm)
            simulated[tbl].append(
                {
                    "partition_name": f"{tbl}_{suffix}",
                    "bound_expression": f"FOR VALUES FROM ('{start_b}') TO ('{end_b}')",
                    "total_bytes": 16384,
                    "estimated_rows": 0,
                    "is_current": offset == 0,
                }
            )
        simulated[tbl].append(
            {
                "partition_name": f"{tbl}_default",
                "bound_expression": "DEFAULT",
                "total_bytes": 8192,
                "estimated_rows": 0,
                "is_current": False,
            }
        )

    return {
        "engine": "sqlite",
        "partitioning_type": "range_by_date",
        "partition_key": "created_at",
        "current_partition_suffix": current_suffix,
        "partition_interval": "monthly",
        "tables": simulated,
        "notice": "Simulated view on SQLite; deployed PostgreSQL cluster utilizes native declarative range partitions.",
    }
