from __future__ import annotations

import logging
from typing import Optional
import redis

from app.core.config import get_settings

logger = logging.getLogger(__name__)

_redis_client: Optional[redis.Redis] = None


def get_redis_client() -> Optional[redis.Redis]:
    global _redis_client
    settings = get_settings()
    if not settings.redis_enabled:
        return None
    if _redis_client is None:
        try:
            _redis_client = redis.Redis.from_url(
                settings.redis_url,
                decode_responses=True,
                socket_connect_timeout=0.5,
                socket_timeout=0.5,
            )
        except Exception as e:
            logger.warning("Could not connect to Redis: %s", e)
            return None
    return _redis_client


def is_redis_available() -> bool:
    client = get_redis_client()
    if client is None:
        return False
    try:
        return client.ping()
    except Exception:
        return False


# Atomic Lua script for in-memory stock reservation
LUA_RESERVE_STOCK = """
local key = KEYS[1]
local qty = tonumber(ARGV[1])
local current = redis.call('GET', key)
if not current then
    return -1
end
if tonumber(current) < qty then
    return 0
end
redis.call('DECRBY', key, qty)
return 1
"""

# Atomic Lua script for rate limiting (sliding/fixed window)
LUA_RATE_LIMIT = """
local key = KEYS[1]
local limit = tonumber(ARGV[1])
local window = tonumber(ARGV[2])
local current = redis.call('INCR', key)
if current == 1 then
    redis.call('EXPIRE', key, window)
end
if current > limit then
    return 0
else
    return 1
end
"""


def fast_reserve_stock(product_id: str, quantity: int) -> int:
    """
    Returns:
     1: Reserved successfully in Redis.
     0: Confirmed sold out / insufficient stock in Redis (Fast-fail without DB lock!).
    -1: Stock not in Redis cache (Proceed to DB source of truth).
    """
    client = get_redis_client()
    if not client:
        return -1
    try:
        res = client.eval(LUA_RESERVE_STOCK, 1, f"stock:{product_id}", quantity)
        return int(res)
    except Exception as e:
        logger.debug("Redis fast_reserve error (falling back to DB): %s", e)
        return -1


def fast_release_stock(product_id: str, quantity: int) -> None:
    """Releases stock back into Redis if key exists."""
    client = get_redis_client()
    if not client:
        return
    try:
        key = f"stock:{product_id}"
        if client.exists(key):
            client.incrby(key, quantity)
    except Exception as e:
        logger.debug("Redis fast_release error: %s", e)


def set_product_stock_cache(product_id: str, available_quantity: int, ttl_seconds: int = 3600) -> None:
    """Warms or updates product stock in Redis."""
    client = get_redis_client()
    if not client:
        return
    try:
        client.set(f"stock:{product_id}", max(0, available_quantity), ex=ttl_seconds)
    except Exception as e:
        logger.debug("Redis set_product_stock_cache error: %s", e)


def check_rate_limit(identifier: str, action: str = "checkout", limit: int = 30, window_seconds: int = 60) -> bool:
    """
    Returns True if request is allowed, False if rate limited.
    Fails open (returns True) if Redis is unavailable so legitimate users aren't locked out.
    """
    client = get_redis_client()
    if not client:
        return True
    try:
        key = f"ratelimit:{action}:{identifier}"
        res = client.eval(LUA_RATE_LIMIT, 1, key, limit, window_seconds)
        return bool(res == 1)
    except Exception as e:
        logger.debug("Redis rate limit error (failing open): %s", e)
        return True
