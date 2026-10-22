from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    app_name: str = "SurgeCart API"
    database_url: str = "postgresql+psycopg://surgecart:surgecart@localhost:5432/surgecart"
    jwt_secret: str = "change-me-for-production"
    jwt_algorithm: str = "HS256"
    access_token_minutes: int = 1440
    demo_payments_enabled: bool = True
    redis_url: str = "redis://localhost:6379/0"
    redis_enabled: bool = True
    reservation_window_minutes: int = 10
    rate_limit_checkout_per_minute: int = 30
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")


@lru_cache
def get_settings() -> Settings:
    return Settings()
