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
    read_replica_url: str | None = None
    read_replica_pool_size: int = 30
    read_replica_max_overflow: int = 50
    waiting_room_enabled: bool = False
    waiting_room_drain_rate: int = 50
    waiting_room_burst_capacity: int = 100
    waiting_room_ticket_ttl_minutes: int = 5
    waitlist_claim_window_minutes: int = 10
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")


@lru_cache
def get_settings() -> Settings:
    return Settings()
