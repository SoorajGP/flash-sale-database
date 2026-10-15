from fastapi import FastAPI

from app.api.router import api_router
from app.core.config import get_settings


def create_app() -> FastAPI:
    app = FastAPI(title=get_settings().app_name, version="0.1.0")
    app.include_router(api_router)
    return app


app = create_app()
