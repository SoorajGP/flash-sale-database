from __future__ import annotations

from datetime import datetime
import enum
import uuid

from sqlalchemy import DateTime, Enum, ForeignKey, Integer, String, func
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base


class WaitlistStatus(str, enum.Enum):
    PENDING = "pending"
    NOTIFIED = "notified"
    CLAIMED = "claimed"
    EXPIRED = "expired"
    CANCELLED = "cancelled"


class FlashSaleWaitlist(Base):
    __tablename__ = "flash_sale_waitlists"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    product_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("products.id", ondelete="CASCADE"), index=True
    )
    flash_sale_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("flash_sales.id", ondelete="SET NULL"), nullable=True, index=True
    )
    user_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL"), nullable=True, index=True
    )
    email: Mapped[str | None] = mapped_column(String(255), nullable=True, index=True)
    status: Mapped[WaitlistStatus] = mapped_column(
        Enum(WaitlistStatus, values_callable=lambda x: [e.value for e in x], name="waitlist_status"),
        default=WaitlistStatus.PENDING,
        index=True,
    )
    position: Mapped[int] = mapped_column(Integer, default=1)
    notified_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    claim_expires_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True, index=True)
    claim_token: Mapped[str | None] = mapped_column(String(64), nullable=True, unique=True, index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), index=True)
