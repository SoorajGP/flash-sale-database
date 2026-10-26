"""
API v1 Root Router
==================
Aggregates all module-level routers under the /api/v1 prefix.
"""
from datetime import UTC, datetime
from typing import Annotated, Any

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.core.redis import is_redis_available
from app.core.security import require_admin
from app.db.partitioning import ensure_date_partitions, get_partition_info
from app.db.session import get_db, get_read_db, get_replica_pool_status, write_engine
from app.modules.carts.router import router as cart_router
from app.modules.catalog.admin_router import router as admin_router
from app.modules.catalog.analytics_router import router as analytics_router
from app.modules.catalog.router import router as catalog_router
from app.modules.inventory.service import release_expired_reservations
from app.modules.orders.router import router as order_router
from app.modules.sales.router import admin_router as sales_admin_router
from app.modules.sales.router import router as sales_router
from app.modules.users.models import User
from app.modules.users.router import router as auth_router
from app.modules.waiting_room.router import admin_router as waiting_room_admin_router
from app.modules.waiting_room.router import router as waiting_room_router
from app.modules.waitlist.router import router as waitlist_router

api_router = APIRouter(prefix="/api/v1")


@api_router.get("/health", tags=["health"])
def health() -> dict[str, str]:
    return {"status": "ok"}


@api_router.get("/system/time", tags=["system"])
def get_system_time() -> dict:
    return {
        "server_time": datetime.now(UTC).isoformat(),
        "redis_available": is_redis_available(),
    }


@api_router.get("/system/cluster", tags=["system"])
def get_cluster_status(db: Annotated[Session, Depends(get_read_db)]) -> dict[str, Any]:
    """
    Returns CQRS cluster topology, read-replica connection status,
    and active table partitioning metrics for orders & inventory_movements.
    """
    return {
        "cqrs_read_replicas": get_replica_pool_status(),
        "table_partitioning": get_partition_info(db),
        "redis_available": is_redis_available(),
    }


@api_router.post("/admin/reservations/cleanup", tags=["admin"])
def cleanup_reservations(
    _: Annotated[User, Depends(require_admin)],
    db: Annotated[Session, Depends(get_db)],
) -> dict:
    released = release_expired_reservations(db)
    return {"status": "success", "released_count": released}


@api_router.post("/admin/partitions/sync", tags=["admin"])
def sync_table_partitions(
    _: Annotated[User, Depends(require_admin)],
    months_ahead: int = 4,
) -> dict[str, Any]:
    """Creates upcoming monthly partitions for high-volume orders & inventory movements."""
    partitions = ensure_date_partitions(write_engine, months_back=1, months_forward=months_ahead)
    return {
        "status": "success",
        "partitions_maintained": partitions,
    }


# ── Module routers ────────────────────────────────────────────────────────
api_router.include_router(catalog_router)
api_router.include_router(auth_router)
api_router.include_router(cart_router)
api_router.include_router(order_router)
api_router.include_router(sales_router)
api_router.include_router(waiting_room_router)
api_router.include_router(waitlist_router)
api_router.include_router(admin_router)              # /admin  (products, dashboard, restock)
api_router.include_router(sales_admin_router)        # /admin/flash-sales
api_router.include_router(analytics_router)          # /admin/analytics
api_router.include_router(waiting_room_admin_router) # /admin/waiting-room
