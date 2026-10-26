import logging
import socket
from typing import Any
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


def _create_engine_for_url(
    target_url: str,
    pool_size: int = 30,
    max_overflow: int = 50,
    read_only: bool = False,
):
    if target_url.startswith("sqlite"):
        return create_engine(target_url, connect_args={"check_same_thread": False})
    
    execution_options = {}
    if read_only:
        execution_options["postgresql_readonly"] = True

    return create_engine(
        target_url,
        pool_pre_ping=True,
        pool_size=pool_size,
        max_overflow=max_overflow,
        pool_timeout=30.0,
        execution_options=execution_options,
    )


def _get_write_engine():
    settings = get_settings()
    target_url = settings.database_url
    if not _check_db_available(target_url):
        logger.info(
            "Primary database host not reachable at %s. Falling back to local SQLite database: surgecart.db",
            target_url,
        )
        target_url = "sqlite:///surgecart.db"

    return _create_engine_for_url(target_url, pool_size=30, max_overflow=50)


def _get_read_engine(primary_engine):
    settings = get_settings()
    replica_url = settings.read_replica_url
    
    if replica_url and _check_db_available(replica_url):
        logger.info("Connected to dedicated read replica pool at %s", replica_url)
        return _create_engine_for_url(
            replica_url,
            pool_size=settings.read_replica_pool_size,
            max_overflow=settings.read_replica_max_overflow,
            read_only=True,
        )

    # If no separate replica URL provided, check if primary is PostgreSQL and create a dedicated read pool
    primary_url = settings.database_url
    if _check_db_available(primary_url) and not str(primary_engine.url).startswith("sqlite"):
        logger.info("Operating dedicated read-pool connection against primary PostgreSQL instance.")
        return _create_engine_for_url(
            primary_url,
            pool_size=settings.read_replica_pool_size,
            max_overflow=settings.read_replica_max_overflow,
            read_only=True,
        )

    # Development SQLite fallback
    return primary_engine


# CQRS Engine & Session Configuration
engine = _get_write_engine()
write_engine = engine
read_engine = _get_read_engine(write_engine)

SessionLocal = sessionmaker(bind=write_engine, autocommit=False, autoflush=False, class_=Session)
WriteSessionLocal = SessionLocal
ReadSessionLocal = sessionmaker(bind=read_engine, autocommit=False, autoflush=False, class_=Session)


def init_db() -> None:
    """Ensure database schema is created, date-range partitions exist, and default data seeded."""
    from app.db.base import Base
    import app.db.models  # noqa: F401
    from app.db.partitioning import ensure_date_partitions
    from app.modules.catalog.models import Product
    from app.seed import seed_db

    Base.metadata.create_all(bind=write_engine)
    
    # Ensure monthly partitions for high-volume orders & inventory movements
    try:
        ensure_date_partitions(write_engine)
    except Exception as e:
        logger.warning("Could not auto-create table partitions: %s", e)

    with SessionLocal.begin() as db:
        if db.scalar(select(Product.id)) is None:
            seed_db(db)
            logger.info("Auto-seeded catalogue products and administrator into database.")


def get_db():
    """Primary write session dependency for state-mutating checkout, inventory, and payment operations."""
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


def get_write_db():
    """Explicit alias for primary write database session."""
    return get_db()


def get_read_db():
    """
    CQRS Read Replica session dependency.
    Directs catalog browsing, product reviews, and analytical queries to the read-replica pool.
    """
    db = ReadSessionLocal()
    try:
        yield db
    finally:
        db.close()


def get_replica_pool_status() -> dict[str, Any]:
    """Returns cluster topology and connection status for primary and read-replica pools."""
    settings = get_settings()
    has_dedicated_replica = bool(settings.read_replica_url and settings.read_replica_url != settings.database_url)
    return {
        "cqrs_enabled": True,
        "primary_engine": str(write_engine.url.render_as_string(hide_password=True)),
        "read_replica_engine": str(read_engine.url.render_as_string(hide_password=True)),
        "dedicated_replica_active": has_dedicated_replica,
        "write_pool_size": getattr(write_engine.pool, "size", lambda: 30)(),
        "read_pool_size": getattr(read_engine.pool, "size", lambda: settings.read_replica_pool_size)(),
    }
