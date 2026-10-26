"""Migrate rows from default partition into monthly range partitions."""
from sqlalchemy import text
from app.db.session import write_engine
from app.db.partitioning import add_months, get_month_partition_bounds

def run():
    with write_engine.begin() as conn:
        if conn.dialect.name != "postgresql":
            return

        for tbl in ["orders", "inventory_movements"]:
            print(f"Distributing {tbl} default partition rows into monthly partitions...")
            
            # Step 1: Copy default rows to temp table and truncate default
            conn.execute(text(f"CREATE TEMP TABLE {tbl}_staging AS SELECT * FROM {tbl}_default;"))
            conn.execute(text(f"TRUNCATE {tbl}_default;"))

            # Step 2: Create monthly partitions for 2026 and 2027
            for offset in range(-2, 7):
                y, m = add_months(2026, 10, offset)
                suffix, start_v, end_v = get_month_partition_bounds(y, m)
                part_name = f"{tbl}_{suffix}"
                conn.execute(text(f"""
                    CREATE TABLE IF NOT EXISTS {part_name}
                    PARTITION OF {tbl}
                    FOR VALUES FROM ('{start_v}') TO ('{end_v}');
                """))

            # Step 3: Re-insert rows into partitioned parent table so PG routes them into partitions
            conn.execute(text(f"INSERT INTO {tbl} SELECT * FROM {tbl}_staging;"))
            conn.execute(text(f"DROP TABLE {tbl}_staging;"))
            print(f"Done distributing {tbl}.")

if __name__ == "__main__":
    run()
