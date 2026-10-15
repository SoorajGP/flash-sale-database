from uuid import UUID

from fastapi import APIRouter, Depends
from pydantic import BaseModel, ConfigDict
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.db.session import get_db
from app.modules.catalog.models import Product

router = APIRouter(prefix="/products", tags=["products"])


class ProductSummary(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    sku: str
    name: str
    price_cents: int
    currency: str


@router.get("", response_model=list[ProductSummary])
def list_active_products(db: Session = Depends(get_db)) -> list[Product]:
    return list(db.scalars(select(Product).where(Product.is_active.is_(True)).order_by(Product.name)))
