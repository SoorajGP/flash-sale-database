"""Restock Waitlist API Router."""
from __future__ import annotations

from typing import Annotated, Any
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel, EmailStr, Field
from sqlalchemy.orm import Session

from app.core.security import get_optional_current_user
from app.db.session import get_db, get_read_db
from app.modules.users.models import User
from app.modules.waitlist.service import (
    claim_waitlist_stock,
    get_user_restock_alerts,
    get_waitlist_telemetry,
    join_waitlist,
)

router = APIRouter(prefix="/waitlist", tags=["waitlist"])


class JoinWaitlistRequest(BaseModel):
    product_id: UUID
    flash_sale_id: UUID | None = None
    email: str | None = None


class ClaimStockRequest(BaseModel):
    claim_token: str = Field(min_length=1)


@router.post("/join", status_code=status.HTTP_201_CREATED)
def join_product_waitlist(
    payload: JoinWaitlistRequest,
    db: Annotated[Session, Depends(get_db)],
    current_user: Annotated[User | None, Depends(get_optional_current_user)] = None,
) -> dict[str, Any]:
    """Allows rejected shoppers to enter the restock waitlist for sold-out items."""
    try:
        user_id = current_user.id if current_user else None
        user_email = current_user.email if current_user else payload.email
        return join_waitlist(
            db=db,
            product_id=payload.product_id,
            flash_sale_id=payload.flash_sale_id,
            user_id=user_id,
            email=user_email,
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.get("/my-alerts")
def get_my_restock_alerts(
    db: Annotated[Session, Depends(get_read_db)],
    email: str | None = Query(default=None),
    current_user: Annotated[User | None, Depends(get_optional_current_user)] = None,
) -> list[dict[str, Any]]:
    """Returns all active 10-minute restock alerts for the customer."""
    user_id = current_user.id if current_user else None
    user_email = current_user.email if current_user else email
    if not user_id and not user_email:
        return []
    return get_user_restock_alerts(db, user_id=user_id, email=user_email)


@router.post("/claim")
def claim_restocked_unit(
    payload: ClaimStockRequest,
    db: Annotated[Session, Depends(get_db)],
) -> dict[str, Any]:
    """Claims a restocked hold from an expired 10-minute reservation alert."""
    try:
        return claim_waitlist_stock(db, claim_token=payload.claim_token)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.get("/stats/{product_id}")
def get_product_stats(
    product_id: UUID,
    db: Annotated[Session, Depends(get_read_db)],
) -> dict[str, Any]:
    """Returns public waitlist depth and notified metrics for a product."""
    return get_waitlist_telemetry(db, product_id=product_id)
