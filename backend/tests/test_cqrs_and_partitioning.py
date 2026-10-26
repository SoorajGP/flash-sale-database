from __future__ import annotations

from fastapi.testclient import TestClient

from app.db.partitioning import add_months, ensure_date_partitions, get_month_partition_bounds, get_partition_info
from app.db.session import SessionLocal, get_replica_pool_status, write_engine
from app.main import app

client = TestClient(app)


def test_cqrs_replica_pool_status():
    status = get_replica_pool_status()
    assert status["cqrs_enabled"] is True
    assert "primary_engine" in status
    assert "read_replica_engine" in status
    assert status["write_pool_size"] >= 1
    assert status["read_pool_size"] >= 1


def test_system_cluster_endpoint():
    res = client.get("/api/v1/system/cluster")
    assert res.status_code == 200
    data = res.json()
    assert "cqrs_read_replicas" in data
    assert data["cqrs_read_replicas"]["cqrs_enabled"] is True
    assert "table_partitioning" in data
    assert "tables" in data["table_partitioning"]
    assert "orders" in data["table_partitioning"]["tables"]
    assert "inventory_movements" in data["table_partitioning"]["tables"]


def test_month_partition_bounds_calculation():
    y, m = add_months(2026, 10, 1)
    assert y == 2026 and m == 11

    y, m = add_months(2026, 12, 1)
    assert y == 2027 and m == 1

    suffix, start_s, end_s = get_month_partition_bounds(2026, 10)
    assert suffix == "y2026m10"
    assert "2026-10-01" in start_s
    assert "2026-11-01" in end_s


def test_table_partitioning_maintenance():
    partitions = ensure_date_partitions(write_engine, months_back=1, months_forward=2)
    assert len(partitions) > 0
    assert any("orders_y" in p for p in partitions)
    assert any("inventory_movements_y" in p for p in partitions)

    db = SessionLocal()
    try:
        info = get_partition_info(db)
        assert info["partition_key"] == "created_at"
        assert info["partition_interval"] == "monthly"
        assert "orders" in info["tables"]
    finally:
        db.close()
