"""
Queue-Based Virtual Waiting Room (Token Bucket / Leaky Bucket Inflow Controller)
================================================================================
Protects database row locks and connection pools under massive concurrency (100,000+ users)
by buffering checkout requests into an in-memory queue that issues numbered tickets.

Architecture:
  1. Monotonically increasing queue tickets (e.g. Ticket #1, #2, ... #100,000+).
  2. In-memory queue backed by Redis Sorted Sets (ZSET) with monotonic score sequencing.
  3. Leaky Bucket / Token Bucket discharge worker that admits shoppers at a controlled rate
     (e.g., 50 checkouts per second) matching database write capacity.
  4. Cryptographic admission tokens with expiry windows (e.g., 5 minutes to checkout).
  5. Fallback in-memory queue implementation for zero-dependency local test environments.
"""
from __future__ import annotations

from datetime import UTC, datetime
import json
import logging
import secrets
import time
from typing import Any
import uuid

from app.core.config import get_settings
from app.core.redis import get_redis_client

logger = logging.getLogger("surgecart.waiting_room")

# In-memory fallback structures when Redis is offline
_in_memory_queue: list[dict[str, Any]] = []
_in_memory_tickets: dict[str, dict[str, Any]] = {}
_in_memory_counter: int = 0
_in_memory_served: int = 0
_in_memory_enabled: bool | None = None


def is_waiting_room_active() -> bool:
    """Returns True if virtual waiting room queuing is active or enabled by admin/traffic threshold."""
    global _in_memory_enabled
    if _in_memory_enabled is not None:
        return _in_memory_enabled
    settings = get_settings()
    client = get_redis_client()
    if client:
        try:
            val = client.get("waiting_room:enabled")
            if val is not None:
                return val in ("1", "true", "True")
        except Exception:
            pass
    return settings.waiting_room_enabled


def set_waiting_room_active(enabled: bool) -> None:
    """Dynamically activates or deactivates virtual waiting room queue gate."""
    global _in_memory_enabled
    _in_memory_enabled = enabled
    client = get_redis_client()
    if client:
        try:
            client.set("waiting_room:enabled", "1" if enabled else "0")
        except Exception:
            pass


def issue_ticket(
    cart_id: str,
    flash_sale_id: str | None = None,
    user_id: str | None = None,
) -> dict[str, Any]:
    """
    Enqueues a shopper into the virtual waiting room and issues a numbered queue ticket.
    If the waiting room is currently inactive, immediately auto-admits the shopper.
    """
    active = is_waiting_room_active()
    client = get_redis_client()
    now_epoch = time.time()
    ticket_id = f"TKT-{uuid.uuid4().hex[:10].upper()}"
    scope = flash_sale_id or "global"

    if client:
        try:
            counter_key = f"waiting_room:counter:{scope}"
            queue_key = f"waiting_room:queue:{scope}"
            ticket_key = f"waiting_room:ticket:{ticket_id}"
            served_key = f"waiting_room:served:{scope}"

            queue_number = client.incr(counter_key)
            current_serving = int(client.get(served_key) or 0)

            # If waiting room not actively gating, auto-admit immediately
            if not active:
                admission_token = secrets.token_urlsafe(24)
                ticket_data = {
                    "ticket_id": ticket_id,
                    "queue_number": queue_number,
                    "cart_id": cart_id,
                    "flash_sale_id": flash_sale_id or "",
                    "user_id": user_id or "",
                    "status": "ADMITTED",
                    "created_at": now_epoch,
                    "admitted_at": now_epoch,
                    "expires_at": now_epoch + (get_settings().waiting_room_ticket_ttl_minutes * 60),
                    "admission_token": admission_token,
                }
                client.set(ticket_key, json.dumps(ticket_data), ex=1800)
                client.set(f"waiting_room:token:{admission_token}", ticket_id, ex=get_settings().waiting_room_ticket_ttl_minutes * 60)
                return {
                    "ticket_id": ticket_id,
                    "queue_number": queue_number,
                    "current_serving": queue_number,
                    "ahead_in_queue": 0,
                    "status": "ADMITTED",
                    "estimated_wait_seconds": 0,
                    "admission_token": admission_token,
                    "expires_at": ticket_data["expires_at"],
                }

            # Enqueue into Redis sorted set with score = queue_number
            client.zadd(queue_key, {ticket_id: queue_number})
            ahead = max(0, queue_number - current_serving)
            drain_rate = max(1, get_settings().waiting_room_drain_rate)
            estimated_wait = int(ahead / drain_rate)

            ticket_data = {
                "ticket_id": ticket_id,
                "queue_number": queue_number,
                "cart_id": cart_id,
                "flash_sale_id": flash_sale_id or "",
                "user_id": user_id or "",
                "status": "WAITING",
                "created_at": now_epoch,
                "admitted_at": None,
                "expires_at": None,
                "admission_token": None,
            }
            client.set(ticket_key, json.dumps(ticket_data), ex=3600)

            return {
                "ticket_id": ticket_id,
                "queue_number": queue_number,
                "current_serving": current_serving,
                "ahead_in_queue": ahead,
                "status": "WAITING",
                "estimated_wait_seconds": estimated_wait,
                "admission_token": None,
            }
        except Exception as e:
            logger.warning("Redis waiting room error (falling back to memory): %s", e)

    # In-memory fallback
    global _in_memory_counter, _in_memory_served
    _in_memory_counter += 1
    queue_number = _in_memory_counter

    if not active:
        admission_token = secrets.token_urlsafe(24)
        ticket_data = {
            "ticket_id": ticket_id,
            "queue_number": queue_number,
            "cart_id": cart_id,
            "flash_sale_id": flash_sale_id or "",
            "user_id": user_id or "",
            "status": "ADMITTED",
            "created_at": now_epoch,
            "admitted_at": now_epoch,
            "expires_at": now_epoch + (get_settings().waiting_room_ticket_ttl_minutes * 60),
            "admission_token": admission_token,
        }
        _in_memory_tickets[ticket_id] = ticket_data
        _in_memory_served = queue_number
        return {
            "ticket_id": ticket_id,
            "queue_number": queue_number,
            "current_serving": queue_number,
            "ahead_in_queue": 0,
            "status": "ADMITTED",
            "estimated_wait_seconds": 0,
            "admission_token": admission_token,
            "expires_at": ticket_data["expires_at"],
        }

    ahead = max(0, queue_number - _in_memory_served)
    drain_rate = max(1, get_settings().waiting_room_drain_rate)
    estimated_wait = int(ahead / drain_rate)

    ticket_data = {
        "ticket_id": ticket_id,
        "queue_number": queue_number,
        "cart_id": cart_id,
        "flash_sale_id": flash_sale_id or "",
        "user_id": user_id or "",
        "status": "WAITING",
        "created_at": now_epoch,
        "admitted_at": None,
        "expires_at": None,
        "admission_token": None,
    }
    _in_memory_tickets[ticket_id] = ticket_data
    _in_memory_queue.append(ticket_data)

    return {
        "ticket_id": ticket_id,
        "queue_number": queue_number,
        "current_serving": _in_memory_served,
        "ahead_in_queue": ahead,
        "status": "WAITING",
        "estimated_wait_seconds": estimated_wait,
        "admission_token": None,
    }


def get_ticket_status(ticket_id: str, flash_sale_id: str | None = None) -> dict[str, Any]:
    """Retrieves real-time ticket position, admission state, and ETA."""
    client = get_redis_client()
    scope = flash_sale_id or "global"

    if client:
        try:
            raw = client.get(f"waiting_room:ticket:{ticket_id}")
            if raw:
                data = json.loads(raw)
                served_key = f"waiting_room:served:{scope}"
                current_serving = int(client.get(served_key) or 0)
                ahead = max(0, data["queue_number"] - current_serving)
                drain_rate = max(1, get_settings().waiting_room_drain_rate)
                estimated_wait = 0 if data["status"] == "ADMITTED" else int(ahead / drain_rate)

                return {
                    "ticket_id": ticket_id,
                    "queue_number": data["queue_number"],
                    "current_serving": current_serving,
                    "ahead_in_queue": ahead,
                    "status": data["status"],
                    "estimated_wait_seconds": estimated_wait,
                    "admission_token": data.get("admission_token"),
                    "expires_at": data.get("expires_at"),
                }
        except Exception as e:
            logger.debug("Redis get_ticket_status error: %s", e)

    data = _in_memory_tickets.get(ticket_id)
    if not data:
        return {"ticket_id": ticket_id, "status": "NOT_FOUND"}

    ahead = max(0, data["queue_number"] - _in_memory_served)
    drain_rate = max(1, get_settings().waiting_room_drain_rate)
    estimated_wait = 0 if data["status"] == "ADMITTED" else int(ahead / drain_rate)

    return {
        "ticket_id": ticket_id,
        "queue_number": data["queue_number"],
        "current_serving": _in_memory_served,
        "ahead_in_queue": ahead,
        "status": data["status"],
        "estimated_wait_seconds": estimated_wait,
        "admission_token": data.get("admission_token"),
        "expires_at": data.get("expires_at"),
    }


def admit_next_batch(count: int = 50, flash_sale_id: str | None = None) -> int:
    """
    Leaky Bucket discharge: Pops up to `count` waiting tickets from queue,
    generates admission tokens, and updates serving position.
    """
    client = get_redis_client()
    scope = flash_sale_id or "global"
    now_epoch = time.time()
    ttl_seconds = get_settings().waiting_room_ticket_ttl_minutes * 60
    admitted_count = 0

    if client:
        try:
            queue_key = f"waiting_room:queue:{scope}"
            served_key = f"waiting_room:served:{scope}"

            # Fetch top tickets by score (queue_number)
            ticket_ids = client.zrange(queue_key, 0, count - 1)
            if not ticket_ids:
                return 0

            for tid in ticket_ids:
                t_key = f"waiting_room:ticket:{tid}"
                raw = client.get(t_key)
                if raw:
                    data = json.loads(raw)
                    if data["status"] == "WAITING":
                        token = secrets.token_urlsafe(24)
                        data["status"] = "ADMITTED"
                        data["admitted_at"] = now_epoch
                        data["expires_at"] = now_epoch + ttl_seconds
                        data["admission_token"] = token
                        client.set(t_key, json.dumps(data), ex=1800)
                        client.set(f"waiting_room:token:{token}", tid, ex=int(ttl_seconds))
                        client.set(served_key, data["queue_number"])
                        admitted_count += 1
                # Remove from waiting queue
                client.zrem(queue_key, tid)

            return admitted_count
        except Exception as e:
            logger.debug("Redis admit_next_batch error: %s", e)

    global _in_memory_served, _in_memory_queue
    batch = _in_memory_queue[:count]
    _in_memory_queue = _in_memory_queue[count:]

    for data in batch:
        token = secrets.token_urlsafe(24)
        data["status"] = "ADMITTED"
        data["admitted_at"] = now_epoch
        data["expires_at"] = now_epoch + ttl_seconds
        data["admission_token"] = token
        _in_memory_tickets[data["ticket_id"]] = data
        _in_memory_served = max(_in_memory_served, data["queue_number"])
        admitted_count += 1

    return admitted_count


def verify_and_consume_token(token: str, cart_id: str) -> bool:
    """
    Validates the admission token during checkout.
    If valid, marks the ticket as COMPLETED to prevent replay attacks.
    """
    if not token:
        return False

    client = get_redis_client()
    now_epoch = time.time()

    if client:
        try:
            ticket_id = client.get(f"waiting_room:token:{token}")
            if not ticket_id:
                return False

            t_key = f"waiting_room:ticket:{ticket_id}"
            raw = client.get(t_key)
            if not raw:
                return False

            data = json.loads(raw)
            if data.get("cart_id") != cart_id:
                return False
            if data.get("status") != "ADMITTED":
                return False
            if data.get("expires_at", 0) < now_epoch:
                data["status"] = "EXPIRED"
                client.set(t_key, json.dumps(data), ex=600)
                return False

            # Mark ticket as COMPLETED
            data["status"] = "COMPLETED"
            client.set(t_key, json.dumps(data), ex=600)
            client.delete(f"waiting_room:token:{token}")
            return True
        except Exception as e:
            logger.debug("Redis verify_and_consume_token error: %s", e)

    # In-memory fallback
    for tid, data in list(_in_memory_tickets.items()):
        if data.get("admission_token") == token:
            if data.get("cart_id") != cart_id:
                return False
            if data.get("status") != "ADMITTED":
                return False
            if data.get("expires_at", 0) < now_epoch:
                data["status"] = "EXPIRED"
                return False
            data["status"] = "COMPLETED"
            return True

    return False


def get_waiting_room_telemetry(flash_sale_id: str | None = None) -> dict[str, Any]:
    """Returns queue telemetry and health statistics."""
    scope = flash_sale_id or "global"
    client = get_redis_client()
    active = is_waiting_room_active()

    if client:
        try:
            queue_key = f"waiting_room:queue:{scope}"
            counter_key = f"waiting_room:counter:{scope}"
            served_key = f"waiting_room:served:{scope}"

            waiting_depth = client.zcard(queue_key) or 0
            total_issued = int(client.get(counter_key) or 0)
            current_served = int(client.get(served_key) or 0)

            return {
                "active": active,
                "engine": "redis_sorted_set",
                "waiting_depth": waiting_depth,
                "total_tickets_issued": total_issued,
                "current_queue_served": current_served,
                "drain_rate_per_sec": get_settings().waiting_room_drain_rate,
                "burst_capacity": get_settings().waiting_room_burst_capacity,
                "ticket_ttl_minutes": get_settings().waiting_room_ticket_ttl_minutes,
            }
        except Exception:
            pass

    return {
        "active": active,
        "engine": "in_memory",
        "waiting_depth": len(_in_memory_queue),
        "total_tickets_issued": _in_memory_counter,
        "current_queue_served": _in_memory_served,
        "drain_rate_per_sec": get_settings().waiting_room_drain_rate,
        "burst_capacity": get_settings().waiting_room_burst_capacity,
        "ticket_ttl_minutes": get_settings().waiting_room_ticket_ttl_minutes,
    }
