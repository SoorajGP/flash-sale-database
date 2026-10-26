import logging
import socket
from urllib.parse import urlparse

from sqlalchemy import create_engine, select
from sqlalchemy.orm import Session, sessionmaker

from app.core.config import get_settings

logger = logging.getLogger("surgecart.db")


def _check_db_available(url_str: str) -> bool:
    try:
        parsed = urlparse(url_str)
        if parsed.scheme.startswith("sqlite"):
            return True
        host = parsed.hostname or "localhost"
        port = parsed.port or 5432
        with socket.create_connection((host, port), timeout=0.8):
            return True
    except Exception:
        return False


def _get_engine():
    settings = get_settings()
    target_url = settings.database_url
    if not _check_db_available(target_url):
        logger.info(
            "Database host not reachable at %s. Falling back to local SQLite database: surgecart.db",
            target_url,
        )
        target_url = "sqlite:///surgecart.db"

    if target_url.startswith("sqlite"):
        return create_engine(target_url, connect_args={"check_same_thread": False})
    return create_engine(
        target_url,
        pool_pre_ping=True,
        pool_size=30,
        max_overflow=50,
        pool_timeout=30.0,
    )


engine = _get_engine()
SessionLocal = sessionmaker(bind=engine, autocommit=False, autoflush=False, class_=Session)


def init_db() -> None:
    """Ensure database schema is created and seeded with default catalogue and admin."""
    from app.db.base import Base
    import app.db.models  # noqa: F401
    from app.modules.catalog.models import Product
    from app.seed import seed_db

    Base.metadata.create_all(bind=engine)
    with SessionLocal.begin() as db:
        if db.scalar(select(Product.id)) is None:
            seed_db(db)
            logger.info("Auto-seeded catalogue products and administrator into database.")


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()

