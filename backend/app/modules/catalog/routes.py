"""
Catalog & Administration Routes re-export
=========================================
Exposes router modules for catalog, product feedback, and administrative catalog management.
"""

from app.modules.catalog.admin_router import router as admin_router
from app.modules.catalog.router import router as catalog_router

__all__ = ["admin_router", "catalog_router"]
