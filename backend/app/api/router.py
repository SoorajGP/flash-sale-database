from fastapi import APIRouter

from app.modules.carts.router import router as cart_router
from app.modules.catalog.admin_router import router as admin_router
from app.modules.catalog.router import router as catalog_router
from app.modules.orders.router import router as order_router
from app.modules.sales.router import admin_router as sales_admin_router, router as sales_router
from app.modules.users.router import router as auth_router

from datetime import UTC, datetime
from typing import Annotated

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.core.redis import is_redis_available
from app.core.security import require_admin
from app.db.session import get_db
from app.modules.inventory.service import release_expired_reservations
from app.modules.users.models import User

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


@api_router.post("/admin/reservations/cleanup", tags=["admin"])
def cleanup_reservations(
    _: Annotated[User, Depends(require_admin)],
    db: Annotated[Session, Depends(get_db)],
) -> dict:
    released = release_expired_reservations(db)
    return {"status": "success", "released_count": released}


api_router.include_router(catalog_router)
api_router.include_router(auth_router)
api_router.include_router(cart_router)
api_router.include_router(order_router)
api_router.include_router(sales_router)
api_router.include_router(admin_router)
api_router.include_router(sales_admin_router)
