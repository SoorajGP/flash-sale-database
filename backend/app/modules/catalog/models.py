from __future__ import annotations

from typing import TYPE_CHECKING, Any
import uuid
from datetime import datetime

from sqlalchemy import Boolean, CheckConstraint, DateTime, Float, ForeignKey, Integer, String, Text, UniqueConstraint, func
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.base import Base

if TYPE_CHECKING:
    from app.modules.users.models import User


class Product(Base):
    __tablename__ = "products"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    sku: Mapped[str] = mapped_column(String(64), unique=True, index=True)
    name: Mapped[str] = mapped_column(String(255))
    description: Mapped[str | None] = mapped_column(Text(), nullable=True)
    price_cents: Mapped[int] = mapped_column(Integer)
    currency: Mapped[str] = mapped_column(String(3), default="USD")
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)

    # Extended catalog & partner metadata
    vendor_id: Mapped[str | None] = mapped_column(String(64), nullable=True, index=True)
    vendor_name: Mapped[str | None] = mapped_column(String(255), nullable=True, index=True)
    media_gallery: Mapped[list[dict[str, Any]]] = mapped_column(
        JSONB, nullable=False, server_default="[]", default=list
    )
    dimensions: Mapped[dict[str, Any] | None] = mapped_column(JSONB, nullable=True)
    weight: Mapped[float | None] = mapped_column(Float, nullable=True)
    category_path: Mapped[str | None] = mapped_column(String(255), nullable=True, index=True)

    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )

    # Relationships
    feedback: Mapped[list[ProductFeedback]] = relationship(
        "ProductFeedback",
        back_populates="product",
        cascade="all, delete-orphan",
        order_by="desc(ProductFeedback.created_at)",
    )


class ProductFeedback(Base):
    __tablename__ = "product_feedback"
    __table_args__ = (
        CheckConstraint("rating_score >= 1 AND rating_score <= 5", name="ck_product_feedback_rating_range"),
        UniqueConstraint("product_id", "user_id", name="uq_product_feedback_product_user"),
    )

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    product_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("products.id", ondelete="CASCADE"), nullable=False, index=True
    )
    user_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True
    )
    rating_score: Mapped[int] = mapped_column(Integer, nullable=False)
    headline: Mapped[str] = mapped_column(String(255), nullable=False)
    body_text: Mapped[str] = mapped_column(Text(), nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )

    # Relationships
    product: Mapped[Product] = relationship("Product", back_populates="feedback")
    user: Mapped[User] = relationship("app.modules.users.models.User")
