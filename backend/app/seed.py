import uuid
from datetime import UTC, datetime, timedelta
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.security import hash_password
from app.db.session import SessionLocal
from app.modules.catalog.models import Product, ProductFeedback
from app.modules.inventory.models import Inventory, InventoryMovement, InventoryMovementType
from app.modules.users.models import User, UserRole


PRODUCT_DEFAULTS = {
    "TRANSIT-RUNNER": {
        "sku": "TRANSIT-RUNNER",
        "name": "Transit Runner",
        "description": "Engineered for daily cadence with a breathable Japanese knit upper, dual-density EVA midsole, and high-traction vibram-grade outsole.",
        "price_cents": 12900,
        "stock": 150,
        "vendor_id": "VND-APEX",
        "vendor_name": "Apex Athletics",
        "category_path": "Footwear > Running > Unisex",
        "dimensions": {"length": 32.0, "width": 21.0, "height": 12.5, "unit": "cm"},
        "weight": 680.0,
        "media_gallery": [
            {"url": "/products/sneaker.jpg", "alt": "Transit Runner lateral studio angle", "display_order": 1},
            {"url": "/products/sneaker.jpg", "alt": "Transit Runner outsole and traction pattern", "display_order": 2},
            {"url": "/products/sneaker.jpg", "alt": "Transit Runner woven upper and collar detail", "display_order": 3},
        ],
    },
    "PULSE-MINI": {
        "sku": "PULSE-MINI",
        "name": "Pulse Mini",
        "description": "Ultra-compact 360-degree acoustic driver featuring IPX5 weatherproofing, custom titanium radiators, and 12-hour continuous battery life.",
        "price_cents": 7900,
        "stock": 80,
        "vendor_id": "VND-AURA",
        "vendor_name": "Aura Acoustics",
        "category_path": "Audio > Portable > Bluetooth",
        "dimensions": {"length": 9.5, "width": 9.5, "height": 11.0, "unit": "cm"},
        "weight": 420.0,
        "media_gallery": [
            {"url": "/products/speaker.jpg", "alt": "Pulse Mini front acoustic grille", "display_order": 1},
            {"url": "/products/speaker.jpg", "alt": "Pulse Mini tactile control array", "display_order": 2},
            {"url": "/products/speaker.jpg", "alt": "Pulse Mini compact profile scale", "display_order": 3},
        ],
    },
    "WEEKENDER-02": {
        "sku": "WEEKENDER-02",
        "name": "Weekender 02",
        "description": "Hand-waxed weatherproof 18oz canvas duffel reinforced with vegetable-tanned Italian leather and brushed antique brass hardware.",
        "price_cents": 9800,
        "stock": 55,
        "vendor_id": "VND-HERITAGE",
        "vendor_name": "Heritage Canvas Co.",
        "category_path": "Carry > Duffels > Travel",
        "dimensions": {"length": 52.0, "width": 28.0, "height": 30.0, "unit": "cm"},
        "weight": 1450.0,
        "media_gallery": [
            {"url": "/products/bag.jpg", "alt": "Weekender 02 full leather and canvas profile", "display_order": 1},
            {"url": "/products/bag.jpg", "alt": "Weekender 02 lined interior compartment", "display_order": 2},
            {"url": "/products/bag.jpg", "alt": "Weekender 02 reinforced brass hardware strap", "display_order": 3},
        ],
    },
}

SAMPLE_USERS = [
    ("alex@example.com", "Alex Morgan", "customer"),
    ("elena.v@example.com", "Elena Vance", "customer"),
    ("marcus.k@example.com", "Marcus Kane", "customer"),
    ("sarah.c@example.com", "Sarah Chen", "customer"),
]

SAMPLE_FEEDBACK = [
    # Transit Runner
    (
        "TRANSIT-RUNNER",
        "alex@example.com",
        5,
        "Remarkably balanced everyday runner",
        "The fit is spot-on and true to size. Cushioning hits the sweet spot between soft rebound and firm road feedback. Zero hotspots even after 10k steps.",
        2,
    ),
    (
        "TRANSIT-RUNNER",
        "elena.v@example.com",
        5,
        "Clean silhouette and exceptional materials",
        "Craftsmanship exceeds pairs twice this price. The Japanese knit upper breathes effortlessly in warm weather, and the minimalist aesthetic pairs with everything.",
        5,
    ),
    (
        "TRANSIT-RUNNER",
        "marcus.k@example.com",
        4,
        "Great traction, slight break-in period",
        "The outsole grips wet pavement with total confidence. Collar was slightly snug on day one but molded to my ankle by day three. Very satisfied.",
        8,
    ),
    # Pulse Mini
    (
        "PULSE-MINI",
        "elena.v@example.com",
        5,
        "Incredible clarity for this footprint",
        "Room-filling 360 sound that does not distort at top volume. Battery held up through an entire weekend camping trip. The matte finish feels very durable.",
        3,
    ),
    (
        "PULSE-MINI",
        "sarah.c@example.com",
        5,
        "Intuitive controls and rock-solid connection",
        "Instant Bluetooth pairing with zero latency. The acoustic driver punches well above its dimensions, with balanced bass and crisp vocal clarity.",
        6,
    ),
    (
        "PULSE-MINI",
        "marcus.k@example.com",
        4,
        "Compact powerhouse with premium heft",
        "Feels substantial in hand. Survives kitchen splashes easily. Wish the charging cable was a bit longer, but battery longevity makes it a non-issue.",
        10,
    ),
    # Weekender 02
    (
        "WEEKENDER-02",
        "sarah.c@example.com",
        5,
        "The gold standard for 3-day travel",
        "Easily accommodates boots, two changes of clothes, dopp kit, and a 15-inch laptop. The waxed canvas repels rain effortlessly and the leather handles are superb.",
        4,
    ),
    (
        "WEEKENDER-02",
        "alex@example.com",
        5,
        "Heirloom-grade craftsmanship",
        "Solid brass zipper glides smoothly under full pack weight. Structurally holds its shape when packing. Received compliments at every airport gate.",
        7,
    ),
]


def seed_db(db: Session) -> None:
    # 1. Admin user
    admin = db.scalar(select(User).where(User.email == "admin@surgecart.local"))
    if admin is None:
        db.add(
            User(
                email="admin@surgecart.local",
                display_name="SurgeCart Admin",
                password_hash=hash_password("change-this-password"),
                role=UserRole.ADMIN,
            )
        )

    # 2. Sample customer accounts
    user_map: dict[str, User] = {}
    for email, display_name, role_val in SAMPLE_USERS:
        u = db.scalar(select(User).where(User.email == email))
        if u is None:
            u = User(
                email=email,
                display_name=display_name,
                password_hash=hash_password("password123"),
                role=UserRole.CUSTOMER,
            )
            db.add(u)
            db.flush()
        user_map[email] = u

    # 3. Storefront products with extended metadata
    product_map: dict[str, Product] = {}
    for sku, pdata in PRODUCT_DEFAULTS.items():
        product = db.scalar(select(Product).where(Product.sku == sku))
        if product is None:
            pid = uuid.uuid5(uuid.NAMESPACE_DNS, sku)
            product = Product(
                id=pid,
                sku=sku,
                name=pdata["name"],
                description=pdata["description"],
                price_cents=pdata["price_cents"],
                vendor_id=pdata["vendor_id"],
                vendor_name=pdata["vendor_name"],
                category_path=pdata["category_path"],
                dimensions=pdata["dimensions"],
                weight=pdata["weight"],
                media_gallery=pdata["media_gallery"],
            )
            db.add(product)
            db.flush()
            db.add(Inventory(product_id=product.id, on_hand_quantity=pdata["stock"]))
            db.add(
                InventoryMovement(
                    product_id=product.id,
                    movement_type=InventoryMovementType.RESTOCK,
                    quantity_delta=pdata["stock"],
                    reference_type="seed",
                    reference_id=product.id,
                    idempotency_key=f"seed:{product.id}",
                )
            )
        else:
            # Backfill extended columns if missing
            product.vendor_id = product.vendor_id or pdata["vendor_id"]
            product.vendor_name = product.vendor_name or pdata["vendor_name"]
            product.category_path = product.category_path or pdata["category_path"]
            product.dimensions = product.dimensions or pdata["dimensions"]
            product.weight = product.weight or pdata["weight"]
            if not product.media_gallery:
                product.media_gallery = pdata["media_gallery"]

        product_map[sku] = product

    db.flush()

    # 4. Verified product reviews
    now = datetime.now(UTC)
    for sku, user_email, rating, headline, body, days_ago in SAMPLE_FEEDBACK:
        p = product_map.get(sku)
        u = user_map.get(user_email)
        if not p or not u:
            continue
        exists = db.scalar(
            select(ProductFeedback.id).where(
                ProductFeedback.product_id == p.id,
                ProductFeedback.user_id == u.id,
            )
        )
        if not exists:
            fb = ProductFeedback(
                product_id=p.id,
                user_id=u.id,
                rating_score=rating,
                headline=headline,
                body_text=body,
                created_at=now - timedelta(days=days_ago),
            )
            db.add(fb)

    db.commit()


def main() -> None:
    with SessionLocal.begin() as db:
        seed_db(db)
    print("Seeded admin, catalog products, vendors, galleries, and verified feedback.")


if __name__ == "__main__":
    main()
