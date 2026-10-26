from __future__ import annotations

import asyncio
from contextlib import asynccontextmanager
import logging

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.api.router import api_router
from app.core.config import get_settings
from app.db.session import SessionLocal, init_db
from app.modules.inventory.service import release_expired_reservations, warm_inventory_cache

logger = logging.getLogger("surgecart")


async def periodic_reservation_cleanup() -> None:
    """Background task running every 30 seconds to reclaim expired inventory holds."""
    while True:
        try:
            await asyncio.sleep(30)
            db = SessionLocal()
            try:
                release_expired_reservations(db)
            finally:
                db.close()
        except asyncio.CancelledError:
            break
        except Exception as e:
            logger.error("Error in periodic_reservation_cleanup: %s", e)


@asynccontextmanager
async def lifespan(_: FastAPI):
    # Ensure tables exist and default data is seeded
    try:
        init_db()
    except Exception as e:
        logger.warning("Could not auto-initialize DB: %s", e)

    # Warm Redis inventory cache on startup
    try:
        db = SessionLocal()
        try:
            warm_inventory_cache(db)
        finally:
            db.close()
    except Exception as e:
        logger.debug("Could not warm initial inventory cache: %s", e)

    cleanup_task = asyncio.create_task(periodic_reservation_cleanup())
    yield
    cleanup_task.cancel()
    try:
        await cleanup_task
    except asyncio.CancelledError:
        pass


def create_app() -> FastAPI:
    app = FastAPI(title=get_settings().app_name, version="0.1.0", lifespan=lifespan)
    app.add_middleware(
        CORSMiddleware,
        allow_origins=["*"],
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )
    app.include_router(api_router)
    return app


app = create_app()

