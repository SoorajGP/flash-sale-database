from __future__ import annotations

import enum
import uuid
from datetime import datetime

from sqlalchemy import CheckConstraint, DateTime, Enum, ForeignKey, Integer, String, UniqueConstraint, func
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base


class FlashSaleStatus(str, enum.Enum):
    DRAFT = "draft"
    SCHEDULED = "scheduled"
    LIVE = "live"
    ENDED = "ended"
    CANCELLED = "cancelled"


class FlashSale(Base):
    __tablename__ = "flash_sales"
    __table_args__ = (CheckConstraint("ends_at > starts_at", name="ck_flash_sale_valid_window"),)

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    name: Mapped[str] = mapped_column(String(255))
    status: Mapped[FlashSaleStatus] = mapped_column(
        Enum(FlashSaleStatus, values_callable=lambda x: [e.value for e in x], name="flash_sale_status"),
        default=FlashSaleStatus.DRAFT,
    )
    starts_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), index=True)
    ends_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )


class FlashSaleProduct(Base):
    __tablename__ = "flash_sale_products"
    __table_args__ = (
        UniqueConstraint("flash_sale_id", "product_id", name="uq_flash_sale_product"),
        CheckConstraint("sale_price_cents >= 0", name="ck_flash_sale_price_nonnegative"),
        CheckConstraint("allocation_quantity > 0", name="ck_flash_sale_allocation_positive"),
        CheckConstraint("per_customer_limit > 0", name="ck_flash_sale_customer_limit_positive"),
    )

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    flash_sale_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("flash_sales.id", ondelete="CASCADE"), index=True
    )
    product_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("products.id", ondelete="RESTRICT"), index=True
    )
    sale_price_cents: Mapped[int] = mapped_column(Integer)
    allocation_quantity: Mapped[int] = mapped_column(Integer)
    per_customer_limit: Mapped[int] = mapped_column(Integer, default=1)
