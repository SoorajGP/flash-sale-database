"""Virtual Waiting Room API Router."""
from __future__ import annotations

from typing import Annotated, Any
from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel, Field

from app.core.security import require_admin
from app.modules.users.models import User
from app.modules.waiting_room.service import (
    admit_next_batch,
    get_ticket_status,
    get_waiting_room_telemetry,
    is_waiting_room_active,
    issue_ticket,
    set_waiting_room_active,
)

router = APIRouter(prefix="/waiting-room", tags=["waiting room"])
admin_router = APIRouter(prefix="/admin/waiting-room", tags=["admin"])


class JoinQueueRequest(BaseModel):
    cart_id: str = Field(min_length=1, description="Cart or session ID entering waiting room")
    flash_sale_id: str | None = Field(default=None, description="Optional target flash sale ID")


class WaitingRoomConfigureRequest(BaseModel):
    enabled: bool = Field(description="Enable or disable virtual waiting room gate")


class WaitingRoomBurstRequest(BaseModel):
    count: int = Field(default=50, ge=1, le=1000, description="Number of waiting shoppers to admit")
    flash_sale_id: str | None = None


@router.post("/join", status_code=status.HTTP_201_CREATED)
def join_waiting_room(payload: JoinQueueRequest) -> dict[str, Any]:
    """
    Enters a shopper into the virtual waiting room queue.
    Issues a numbered queue ticket with live ETA and position.
    """
    return issue_ticket(
        cart_id=payload.cart_id,
        flash_sale_id=payload.flash_sale_id,
    )


@router.get("/status/{ticket_id}")
def check_ticket_status(
    ticket_id: str,
    flash_sale_id: str | None = Query(default=None),
) -> dict[str, Any]:
    """Retrieves live queue position, estimated wait time, or admission token."""
    res = get_ticket_status(ticket_id=ticket_id, flash_sale_id=flash_sale_id)
    if res.get("status") == "NOT_FOUND":
        raise HTTPException(status_code=404, detail="Queue ticket not found")
    return res


@router.get("/metrics")
def get_metrics(flash_sale_id: str | None = Query(default=None)) -> dict[str, Any]:
    """Public telemetry for waiting room throughput and queue depth."""
    return get_waiting_room_telemetry(flash_sale_id=flash_sale_id)


# ── Admin Routes ─────────────────────────────────────────────────────────────

@admin_router.post("/configure")
def configure_waiting_room(
    payload: WaitingRoomConfigureRequest,
    _: Annotated[User, Depends(require_admin)],
) -> dict[str, Any]:
    """Activates or deactivates virtual waiting room queuing gate."""
    set_waiting_room_active(payload.enabled)
    return {
        "status": "success",
        "waiting_room_active": is_waiting_room_active(),
    }


@admin_router.post("/admit")
def manual_burst_admit(
    payload: WaitingRoomBurstRequest,
    _: Annotated[User, Depends(require_admin)],
) -> dict[str, Any]:
    """Manually discharges a batch of waiting tickets from the leaky bucket."""
    admitted = admit_next_batch(count=payload.count, flash_sale_id=payload.flash_sale_id)
    return {
        "status": "success",
        "admitted_count": admitted,
        "telemetry": get_waiting_room_telemetry(payload.flash_sale_id),
    }
