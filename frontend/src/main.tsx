/**
 * SurgeCart – Storefront & Administrative Management Console
 * ============================================================
 * Production architecture separating Storefront and Admin Console:
 *
 * Storefront:
 *   - Live Flash Sale Slider: Neat, interactive horizontal carousel for items currently on sale.
 *   - Catalog with real-time stock availability & units remaining for sale.
 *   - Search & category filter toolbar for quick catalog discovery.
 *   - User Delivery Address storage per user with inline checkout editor.
 *   - Cart drawer and atomic checkout reservations.
 *
 * Admin Console:
 *   - Dedicated administrative view (zero storefront clutter).
 *   - Executive Overview & Inventory maintenance controls.
 *   - Analytics & Performance (revenue, group-by top products, sell-out velocity).
 *   - Flash Sale event scheduler with date-time boundaries and product checklist.
 *
 * Design constraints:
 *   - Strictly NO emojis anywhere across the application.
 *   - Elegant editorial aesthetic with fine borders and tabular numerals.
 */

import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";

// ─── Type definitions ────────────────────────────────────────────────────────

/** Shape returned by the enriched GET /api/v1/products endpoint */
type ApiProduct = {
  id: string;
  sku: string;
  name: string;
  description?: string;
  price_cents: number;
  currency: string;
  on_hand_quantity: number;
  available_quantity: number;
  flash_sale?: {
    flash_sale_id: string;
    flash_sale_product_id: string;
    flash_sale_name: string;
    sale_price_cents: number;
    allocation_quantity: number;
    units_sold: number;
    units_remaining: number;
    per_customer_limit: number;
    sale_starts_at: string;
    sale_ends_at: string;
  } | null;
};

/** Internal UI product shape */
type Product = {
  id: string;
  sku: string;
  name: string;
  price: number;
  salePrice?: number;
  badge: string;
  color: string;
  imageUrl?: string;
  description?: string;
  rating?: number;
  reviewCount?: number;
  category?: string;
  availableQty: number;
  totalStock: number;
  flashSale?: ApiProduct["flash_sale"];
};

type CartItem = {
  product: Product;
  quantity: number;
};

type Session = {
  token: string;
  role: string;
  displayName: string;
  email?: string;
};

type DeliveryAddress = {
  id: string;
  label: string;
  fullName: string;
  street: string;
  city: string;
  state: string;
  postalCode: string;
  country: string;
};

type Toast = {
  id: string;
  message: string;
  actionLabel?: string;
  onAction?: () => void;
  type?: "success" | "error" | "info";
};

type CompletedOrder = {
  orderNumber: string;
  totalCents: number;
  currency: string;
  items: CartItem[];
  deliveryAddress?: DeliveryAddress;
};

/** Shape returned by GET /api/v1/admin/analytics */
type AnalyticsData = {
  total_revenue_cents: number;
  total_orders: number;
  top_products: {
    product_id: string;
    product_name: string;
    product_sku: string;
    units_sold: number;
    revenue_cents: number;
    order_count: number;
  }[];
  flash_sale_velocity: {
    flash_sale_id: string;
    flash_sale_name: string;
    product_id: string;
    allocation_quantity: number;
    units_sold: number;
    units_remaining: number;
    sell_through_pct: number;
    velocity_units_per_hour: number;
    sale_starts_at: string;
    sale_ends_at: string;
    is_live: boolean;
  }[];
};

// ─── Static enrichment maps ─────────────────────────────────────────────────

const enrichmentMap: Record<string, Partial<Product>> = {
  "TRANSIT-RUNNER": {
    imageUrl: "/products/sneaker.jpg",
    description: "Suede & mesh upper. Cushioned EVA midsole. Unisex sizing.",
    rating: 4.8, reviewCount: 214, category: "Footwear", totalStock: 150,
  },
  "PULSE-MINI": {
    imageUrl: "/products/speaker.jpg",
    description: "360 sound. IPX5 waterproof. 12-hour battery. Bluetooth 5.3.",
    rating: 4.6, reviewCount: 98, category: "Audio", totalStock: 200,
  },
  "WEEKENDER-02": {
    imageUrl: "/products/bag.jpg",
    description: "Waxed canvas shell. Full-grain leather trim. 42L capacity.",
    rating: 4.9, reviewCount: 357, category: "Carry", totalStock: 80,
  },
};

const uuidEnrichMap: Record<string, Partial<Product>> = {
  "867ba046-d776-5cb0-941d-56cb7d3a812f": enrichmentMap["TRANSIT-RUNNER"],
  "5299be1f-2ea3-5d48-afb5-a728135d958e": enrichmentMap["PULSE-MINI"],
  "422f1457-f19d-5f3a-89a2-64f2fd21789f": enrichmentMap["WEEKENDER-02"],
};

const COLORS = ["sand", "blue", "olive", "terracotta"];

const DEFAULT_SAVED_ADDRESSES: DeliveryAddress[] = [
  {
    id: "addr-home",
    label: "Home",
    fullName: "Sooraj G P",
    street: "742 Evergreen Terrace",
    city: "Springfield",
    state: "OR",
    postalCode: "97477",
    country: "United States",
  },
  {
    id: "addr-office",
    label: "Office",
    fullName: "Sooraj G P",
    street: "100 Tech Park Way, Suite 400",
    city: "Portland",
    state: "OR",
    postalCode: "97201",
    country: "United States",
  },
];

const DEFAULT_ADDRESS: DeliveryAddress = DEFAULT_SAVED_ADDRESSES[0];

const emptyAddressDraft: Omit<DeliveryAddress, "id"> = {
  label: "Home",
  fullName: "",
  street: "",
  city: "",
  state: "",
  postalCode: "",
  country: "United States",
};

// ─── Utility helpers ─────────────────────────────────────────────────────────

const formatPrice = (value: number) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(value);

const formatCents = (cents: number) => formatPrice(cents / 100);

const fmtCountdown = (secs: number): string => {
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = secs % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
};

// ─── SVG Icons (Standardized & Classy, No Emojis) ───────────────────────────

function IconDollar() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <line x1="12" y1="1" x2="12" y2="23" />
      <path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6" />
    </svg>
  );
}

function IconBox() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z" />
      <polyline points="3.27 6.96 12 12.01 20.73 6.96" />
      <line x1="12" y1="22.08" x2="12" y2="12" />
    </svg>
  );
}

function IconSpeed() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="10" />
      <polyline points="12 6 12 12 16 14" />
    </svg>
  );
}

function IconRefresh() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M23 4v6h-6" />
      <path d="M1 20v-6h6" />
      <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
    </svg>
  );
}

function IconCheck() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <polyline points="20 6 9 17 4 12" />
    </svg>
  );
}

function IconAlert() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="10" />
      <line x1="12" y1="8" x2="12" y2="12" />
      <line x1="12" y1="16" x2="12.01" y2="16" />
    </svg>
  );
}

function IconInfo() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="10" />
      <line x1="12" y1="16" x2="12" y2="12" />
      <line x1="12" y1="8" x2="12.01" y2="8" />
    </svg>
  );
}

function IconSearch() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="11" cy="11" r="8" />
      <line x1="21" y1="21" x2="16.65" y2="16.65" />
    </svg>
  );
}

function IconPin() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M21 10c0 7-9 13-9 13S3 17 3 10a9 9 0 0 1 18 0z" />
      <circle cx="12" cy="10" r="3" />
    </svg>
  );
}

// ─── Sub-components ──────────────────────────────────────────────────────────

function StarRating({ rating }: { rating: number }) {
  const full = Math.floor(rating);
  const half = rating - full >= 0.5;
  return (
    <span className="stars" aria-label={`${rating} out of 5`}>
      {Array.from({ length: 5 }, (_, i) => {
        if (i < full) return <span key={i} className="star filled">&#9733;</span>;
        if (i === full && half) return <span key={i} className="star half">&#9733;</span>;
        return <span key={i} className="star">&#9733;</span>;
      })}
    </span>
  );
}

/**
 * StockBar accurately visualizes:
 * - Flash sale items: units remaining of the allocated flash sale batch.
 * - Regular items: total on-hand available inventory in general catalog.
 */
function StockBar({
  available,
  total,
  isFlashSale = false,
}: {
  available: number;
  total: number;
  isFlashSale?: boolean;
}) {
  const pct = Math.max(0, Math.min(100, (available / Math.max(total, 1)) * 100));
  const low = isFlashSale ? available <= 5 : available <= 15;

  let labelText = `${available} available`;
  if (isFlashSale) {
    if (available === 0) {
      labelText = "Flash allocation sold out";
    } else if (low) {
      labelText = `Only ${available} left for sale!`;
    } else {
      labelText = `${available} of ${total} left for sale`;
    }
  } else {
    if (available === 0) {
      labelText = "Sold out";
    } else if (low) {
      labelText = `Only ${available} left`;
    } else {
      labelText = `${available} available`;
    }
  }

  return (
    <div className="stock-bar-wrap">
      <div className="stock-bar-track">
        <div className={`stock-bar-fill ${low ? "low" : ""}`} style={{ width: `${pct}%` }} />
      </div>
      <span className={`stock-label ${low ? "low" : ""} ${isFlashSale ? "flash-remaining" : ""}`}>
        {labelText}
      </span>
    </div>
  );
}

function FlashCountdown({ endsAt, serverOffsetMs }: { endsAt: string; serverOffsetMs: number }) {
  const endMs = useMemo(() => new Date(endsAt).getTime(), [endsAt]);

  const calcRemaining = useCallback(() => {
    const adjustedNow = Date.now() + serverOffsetMs;
    return Math.max(0, Math.floor((endMs - adjustedNow) / 1000));
  }, [endMs, serverOffsetMs]);

  const [secs, setSecs] = useState(calcRemaining);

  useEffect(() => {
    setSecs(calcRemaining());
    const id = setInterval(() => setSecs(calcRemaining()), 1000);
    return () => clearInterval(id);
  }, [calcRemaining]);

  if (secs === 0) return <span className="flash-countdown expired">Concluded</span>;

  return (
    <div className="flash-countdown">
      <span className="flash-countdown-label">Ends in</span>
      <span className="flash-countdown-value" aria-live="polite" aria-label={`Flash sale ends in ${fmtCountdown(secs)}`}>
        {fmtCountdown(secs)}
      </span>
    </div>
  );
}

// ─── Storefront: Interactive Flash Sale Slider ──────────────────────────────

function FlashSaleSlider({
  products,
  serverOffsetMs,
  onAddToBag,
  recentlyAddedId,
}: {
  products: Product[];
  serverOffsetMs: number;
  onAddToBag: (p: Product) => void;
  recentlyAddedId: string | null;
}) {
  const flashProducts = useMemo(() => products.filter((p) => p.flashSale), [products]);
  const viewportRef = useRef<HTMLDivElement>(null);
  const [activeIndex, setActiveIndex] = useState(0);

  if (flashProducts.length === 0) return null;

  const handleScroll = (dir: "left" | "right") => {
    if (!viewportRef.current) return;
    const scrollAmount = 344; // card width + gap
    viewportRef.current.scrollBy({
      left: dir === "left" ? -scrollAmount : scrollAmount,
      behavior: "smooth",
    });
  };

  const onViewportScroll = () => {
    if (!viewportRef.current) return;
    const scrollPos = viewportRef.current.scrollLeft;
    const newIdx = Math.round(scrollPos / 344);
    setActiveIndex(Math.max(0, Math.min(flashProducts.length - 1, newIdx)));
  };

  return (
    <section className="flash-slider-section" id="flash-sale-slider">
      <div className="flash-slider-header">
        <div>
          <span className="admin-eyebrow">LIVE FLASH EVENT</span>
          <h2>Active Flash Drops</h2>
          <p className="flash-slider-sub">
            Limited allocations at promotional pricing. Claim your allocation before the timer expires.
          </p>
        </div>
        <div className="flash-slider-controls">
          <button
            className="flash-slider-btn"
            onClick={() => handleScroll("left")}
            disabled={activeIndex === 0}
            aria-label="Previous flash drop"
          >
            &larr;
          </button>
          <button
            className="flash-slider-btn"
            onClick={() => handleScroll("right")}
            disabled={activeIndex >= flashProducts.length - 1}
            aria-label="Next flash drop"
          >
            &rarr;
          </button>
        </div>
      </div>

      <div
        className="flash-slider-viewport"
        ref={viewportRef}
        onScroll={onViewportScroll}
      >
        <div className="flash-slider-track">
          {flashProducts.map((product) => {
            const isAdded = recentlyAddedId === product.id;
            const remaining = product.flashSale?.units_remaining ?? 0;
            const allocation = product.flashSale?.allocation_quantity ?? product.totalStock;
            const isOut = remaining === 0;

            return (
              <div key={product.id} className="flash-slider-card" id={`slider-card-${product.id}`}>
                <div className="product-image-wrap">
                  {product.imageUrl ? (
                    <img src={product.imageUrl} alt={product.name} className="product-img" loading="eager" />
                  ) : (
                    <div className={`product-image-fallback ${product.color}`}>
                      <div className="shape" />
                    </div>
                  )}
                  <div className="flash-ribbon">FLASH SALE</div>
                  <span className="product-badge flash">Flash Deal</span>
                  {product.category && <span className="product-category">{product.category}</span>}
                </div>

                <div className="product-body">
                  <div className="product-meta">
                    {product.rating !== undefined && (
                      <div className="product-rating">
                        <StarRating rating={product.rating} />
                        <span className="review-count">({product.reviewCount})</span>
                      </div>
                    )}
                    <h3 className="product-name">{product.name}</h3>
                    {product.description && <p className="product-desc">{product.description}</p>}
                  </div>

                  <div className="product-footer">
                    {product.flashSale && (
                      <FlashCountdown
                        endsAt={product.flashSale.sale_ends_at}
                        serverOffsetMs={serverOffsetMs}
                      />
                    )}

                    {/* Displays exact units remaining for sale */}
                    <StockBar
                      available={remaining}
                      total={allocation}
                      isFlashSale={true}
                    />

                    <div className="product-price-row">
                      <div className="product-price-group">
                        <span className="product-price flash">{formatPrice(product.salePrice ?? product.price)}</span>
                        <span className="product-price-original">{formatPrice(product.price)}</span>
                      </div>
                      <button
                        className={`product-add-btn flash-btn ${isAdded ? "added" : ""}`}
                        onClick={() => !isOut && onAddToBag(product)}
                        disabled={isOut}
                        id={`btn-slider-add-${product.id}`}
                      >
                        {isOut ? "Sold Out" : isAdded ? "Added" : "Add to Bag"}
                      </button>
                    </div>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {flashProducts.length > 1 && (
        <div className="flash-slider-dots">
          {flashProducts.map((_, i) => (
            <button
              key={i}
              className={`flash-slider-dot ${activeIndex === i ? "active" : ""}`}
              onClick={() => {
                if (viewportRef.current) {
                  viewportRef.current.scrollTo({ left: i * 344, behavior: "smooth" });
                }
              }}
              aria-label={`Slide ${i + 1}`}
            />
          ))}
        </div>
      )}
    </section>
  );
}

// ─── Admin: Analytics Tab ────────────────────────────────────────────────────

function AnalyticsTab({ token }: { token: string }) {
  const [data, setData] = useState<AnalyticsData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const load = useCallback(() => {
    setLoading(true);
    setError("");
    fetch("/api/v1/admin/analytics", { headers: { Authorization: `Bearer ${token}` } })
      .then((r) => (r.ok ? r.json() : Promise.reject(r.statusText)))
      .then(setData)
      .catch((e) => setError(String(e)))
      .finally(() => setLoading(false));
  }, [token]);

  useEffect(() => { load(); }, [load]);

  if (loading) return <div className="analytics-loading">Loading analytics metrics...</div>;
  if (error) {
    return (
      <div className="analytics-error">
        <span>Unable to fetch analytics: {error}</span>
        <button onClick={load} className="inline-link">Retry</button>
      </div>
    );
  }
  if (!data) return null;

  return (
    <div className="analytics-pane" id="analytics-pane">
      {/* ── KPI cards ── */}
      <div className="kpi-grid">
        <div className="kpi-card">
          <div className="kpi-top">
            <span className="kpi-label">Total Revenue</span>
            <span className="kpi-icon-badge"><IconDollar /></span>
          </div>
          <div className="kpi-value">{formatCents(data.total_revenue_cents)}</div>
          <div className="kpi-sub">{data.total_orders} settled orders</div>
        </div>

        <div className="kpi-card">
          <div className="kpi-top">
            <span className="kpi-label">Completed Orders</span>
            <span className="kpi-icon-badge"><IconBox /></span>
          </div>
          <div className="kpi-value">{data.total_orders.toLocaleString()}</div>
          <div className="kpi-sub">
            Average {data.total_orders > 0 ? formatCents(Math.round(data.total_revenue_cents / data.total_orders)) : "$0.00"} per order
          </div>
        </div>

        <div className="kpi-card">
          <div className="kpi-top">
            <span className="kpi-label">Peak Sell-out Velocity</span>
            <span className="kpi-icon-badge"><IconSpeed /></span>
          </div>
          <div className="kpi-value">
            {data.flash_sale_velocity.length > 0
              ? `${data.flash_sale_velocity[0].velocity_units_per_hour.toFixed(1)} /hr`
              : "—"}
          </div>
          <div className="kpi-sub">
            {data.flash_sale_velocity.find((v) => v.is_live) ? "Active sale in progress" : "No live sales running"}
          </div>
        </div>
      </div>

      {/* ── Top Products table ── */}
      {data.top_products.length > 0 && (
        <div className="analytics-section">
          <div className="analytics-section-header">
            <div>
              <h3 className="analytics-section-title">Catalog Performance</h3>
              <p className="analytics-section-desc">Ranked by unit demand and aggregate order revenue.</p>
            </div>
          </div>
          <div className="analytics-table-wrap">
            <table className="analytics-table" id="top-products-table">
              <thead>
                <tr>
                  <th style={{ width: 60 }}>Rank</th>
                  <th>Product</th>
                  <th>SKU</th>
                  <th className="num">Units Sold</th>
                  <th className="num">Revenue</th>
                  <th className="num">Orders</th>
                </tr>
              </thead>
              <tbody>
                {data.top_products.map((p, i) => (
                  <tr key={p.product_id}>
                    <td className="rank">#{i + 1}</td>
                    <td className="prod-name">{p.product_name}</td>
                    <td className="mono">{p.product_sku}</td>
                    <td className="num">{p.units_sold.toLocaleString()}</td>
                    <td className="num">{formatCents(p.revenue_cents)}</td>
                    <td className="num">{p.order_count.toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* ── Flash Sale Velocity ── */}
      {data.flash_sale_velocity.length > 0 && (
        <div className="analytics-section">
          <div className="analytics-section-header">
            <div>
              <h3 className="analytics-section-title">Flash Sale Velocity &amp; Depletion</h3>
              <p className="analytics-section-desc">Real-time allocation exhaustion rate calculated from order timestamps.</p>
            </div>
          </div>
          <div className="velocity-grid">
            {data.flash_sale_velocity.map((v) => (
              <div
                key={`${v.flash_sale_id}-${v.product_id}`}
                className={`velocity-card ${v.is_live ? "live" : "ended"}`}
                id={`velocity-${v.product_id}`}
              >
                <div className="velocity-header">
                  <span className="velocity-sale-name">{v.flash_sale_name}</span>
                  <span className={`velocity-status-pill ${v.is_live ? "live" : "ended"}`}>
                    <span className="status-dot" />
                    {v.is_live ? "Live" : "Ended"}
                  </span>
                </div>
                <div className="velocity-progress-wrap">
                  <div className="velocity-progress-bar">
                    <div
                      className="velocity-progress-fill"
                      style={{ width: `${Math.min(100, v.sell_through_pct)}%` }}
                    />
                  </div>
                  <span className="velocity-pct">{v.sell_through_pct}%</span>
                </div>
                <div className="velocity-stats">
                  <span>{v.units_sold} allocated sold</span>
                  <span>{v.units_remaining} of {v.allocation_quantity} remain</span>
                </div>
                <div className="velocity-rate">
                  <strong>{v.velocity_units_per_hour.toFixed(2)}</strong>
                  <span> units / hour</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="analytics-footer-actions">
        <button className="admin-btn secondary" onClick={load} id="btn-refresh-analytics">
          <IconRefresh />
          <span>Refresh Analytics</span>
        </button>
      </div>
    </div>
  );
}

// ─── Admin: Create Flash Sale Tab ────────────────────────────────────────────

type ProductCheck = {
  id: string;
  sku: string;
  name: string;
  price_cents: number;
  selected: boolean;
  salePriceCents: string;
  allocation: string;
  perCustomerLimit: string;
};

function CreateFlashSaleTab({
  token,
  onNotify,
}: {
  token: string;
  onNotify: (msg: string, type?: "success" | "error") => void;
}) {
  const [saleName, setSaleName] = useState("");
  const [startsAt, setStartsAt] = useState("");
  const [endsAt, setEndsAt] = useState("");
  const [productSearch, setProductSearch] = useState("");
  const [products, setProducts] = useState<ProductCheck[]>([]);
  const [loadingProducts, setLoadingProducts] = useState(true);
  const [isSubmitting, setIsSubmitting] = useState(false);

  useEffect(() => {
    fetch("/api/v1/products")
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then((items: ApiProduct[]) => {
        setProducts(
          items.map((p) => ({
            id: p.id,
            sku: p.sku,
            name: p.name,
            price_cents: p.price_cents,
            selected: false,
            salePriceCents: "",
            allocation: "",
            perCustomerLimit: "1",
          }))
        );
      })
      .catch(() => onNotify("Could not load product catalogue.", "error"))
      .finally(() => setLoadingProducts(false));
  }, [onNotify]);

  const filteredProducts = useMemo(() =>
    products.filter(
      (p) =>
        p.name.toLowerCase().includes(productSearch.toLowerCase()) ||
        p.sku.toLowerCase().includes(productSearch.toLowerCase())
    ),
    [products, productSearch]
  );

  const toggleProduct = (id: string) => {
    setProducts((prev) =>
      prev.map((p) => (p.id === id ? { ...p, selected: !p.selected } : p))
    );
  };

  const updateProductField = (id: string, field: keyof ProductCheck, value: string) => {
    setProducts((prev) =>
      prev.map((p) => (p.id === id ? { ...p, [field]: value } : p))
    );
  };

  const selectedProducts = products.filter((p) => p.selected);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!saleName.trim() || !startsAt || !endsAt) {
      onNotify("Please specify event title, start timestamp, and conclusion timestamp.", "error");
      return;
    }
    if (new Date(endsAt) <= new Date(startsAt)) {
      onNotify("End timestamp must be strictly after start timestamp.", "error");
      return;
    }
    if (selectedProducts.length === 0) {
      onNotify("Please select at least one catalog item to participate in this flash sale.", "error");
      return;
    }
    for (const p of selectedProducts) {
      if (!p.salePriceCents || !p.allocation) {
        onNotify(`Please assign both sale price and inventory allocation for: ${p.name}.`, "error");
        return;
      }
    }

    setIsSubmitting(true);
    try {
      const saleRes = await fetch("/api/v1/admin/flash-sales", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          name: saleName.trim(),
          starts_at: new Date(startsAt).toISOString(),
          ends_at: new Date(endsAt).toISOString(),
        }),
      });
      if (!saleRes.ok) {
        const err = await saleRes.json().catch(() => ({}));
        throw new Error(err.detail ?? "Failed to create flash sale event.");
      }
      const saleData = await saleRes.json();
      const saleId: string = saleData.id;

      const errors: string[] = [];
      for (const p of selectedProducts) {
        const pRes = await fetch(`/api/v1/admin/flash-sales/${saleId}/products`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
          body: JSON.stringify({
            product_id: p.id,
            sale_price_cents: Math.round(parseFloat(p.salePriceCents) * 100),
            allocation_quantity: parseInt(p.allocation, 10),
            per_customer_limit: parseInt(p.perCustomerLimit || "1", 10),
          }),
        });
        if (!pRes.ok) {
          const err = await pRes.json().catch(() => ({}));
          errors.push(`${p.name}: ${err.detail ?? "assignment failure"}`);
        }
      }

      if (errors.length > 0) {
        onNotify(`Event created with partial errors: ${errors.join("; ")}`, "error");
      } else {
        onNotify(`Flash sale "${saleData.name}" created with ${selectedProducts.length} assigned product(s).`, "success");
        setSaleName("");
        setStartsAt("");
        setEndsAt("");
        setProductSearch("");
        setProducts((prev) =>
          prev.map((p) => ({ ...p, selected: false, salePriceCents: "", allocation: "", perCustomerLimit: "1" }))
        );
      }
    } catch (err: unknown) {
      onNotify((err as Error).message ?? "An error occurred.", "error");
    } finally {
      setIsSubmitting(false);
    }
  };

  const autoFillSalePrice = (p: ProductCheck) => {
    const suggested = Math.round(p.price_cents * 0.8) / 100;
    updateProductField(p.id, "salePriceCents", suggested.toString());
  };

  return (
    <form className="create-sale-form" onSubmit={(e) => void handleSubmit(e)} id="create-flash-sale-form">
      <div className="create-sale-section">
        <h3 className="create-sale-section-title">1. Event Schedule &amp; Identity</h3>
        <p className="create-sale-hint">
          Configure start and end boundaries. Overlapping assignments for identical products are strictly prevented by the database.
        </p>
        <div className="create-sale-fields">
          <label className="create-sale-label">
            Event Name
            <input
              type="text"
              value={saleName}
              onChange={(e) => setSaleName(e.target.value)}
              placeholder="e.g. Autumn Midnight Release"
              className="create-sale-input"
              id="input-sale-name"
              required
            />
          </label>
          <label className="create-sale-label">
            Start Timestamp
            <input
              type="datetime-local"
              value={startsAt}
              onChange={(e) => setStartsAt(e.target.value)}
              className="create-sale-input"
              id="input-sale-starts-at"
              required
            />
          </label>
          <label className="create-sale-label">
            End Timestamp
            <input
              type="datetime-local"
              value={endsAt}
              onChange={(e) => setEndsAt(e.target.value)}
              className="create-sale-input"
              id="input-sale-ends-at"
              required
            />
          </label>
        </div>
      </div>

      <div className="create-sale-section">
        <h3 className="create-sale-section-title">2. Select Catalog Items &amp; Set Allocations</h3>
        <p className="create-sale-hint">
          Check items to participate. Set specific discounted prices and reserved stock quantities.
        </p>
        <input
          type="search"
          value={productSearch}
          onChange={(e) => setProductSearch(e.target.value)}
          placeholder="Filter catalog by product name or SKU..."
          className="create-sale-search"
          id="input-product-search"
        />

        {loadingProducts ? (
          <div className="create-sale-loading">Loading catalog items...</div>
        ) : (
          <div className="product-checklist" role="group" aria-label="Product checklist">
            {filteredProducts.map((p) => (
              <div
                key={p.id}
                className={`product-check-row ${p.selected ? "selected" : ""}`}
                id={`check-row-${p.id}`}
              >
                <label className="product-check-label">
                  <input
                    type="checkbox"
                    checked={p.selected}
                    onChange={() => toggleProduct(p.id)}
                    id={`check-${p.id}`}
                    className="product-checkbox"
                  />
                  <span className="product-check-name">{p.name}</span>
                  <span className="product-check-sku">{p.sku}</span>
                  <span className="product-check-retail">Retail: {formatCents(p.price_cents)}</span>
                </label>

                {p.selected && (
                  <div className="product-check-fields">
                    <label className="pf-label">
                      Sale Price ($)
                      <div className="pf-input-row">
                        <input
                          type="number"
                          min="0"
                          step="0.01"
                          value={p.salePriceCents}
                          onChange={(e) => updateProductField(p.id, "salePriceCents", e.target.value)}
                          placeholder="e.g. 79.99"
                          className="pf-input"
                          id={`input-sale-price-${p.id}`}
                          required={p.selected}
                        />
                        <button
                          type="button"
                          className="pf-autofill"
                          onClick={() => autoFillSalePrice(p)}
                          title="Apply 20% discount"
                        >
                          -20% Retail
                        </button>
                      </div>
                    </label>
                    <label className="pf-label">
                      Stock Allocation
                      <input
                        type="number"
                        min="1"
                        value={p.allocation}
                        onChange={(e) => updateProductField(p.id, "allocation", e.target.value)}
                        placeholder="e.g. 50"
                        className="pf-input"
                        id={`input-allocation-${p.id}`}
                        required={p.selected}
                      />
                    </label>
                    <label className="pf-label">
                      Customer Limit
                      <input
                        type="number"
                        min="1"
                        max="20"
                        value={p.perCustomerLimit}
                        onChange={(e) => updateProductField(p.id, "perCustomerLimit", e.target.value)}
                        className="pf-input"
                        id={`input-limit-${p.id}`}
                      />
                    </label>
                  </div>
                )}
              </div>
            ))}
            {filteredProducts.length === 0 && (
              <div className="create-sale-empty">No catalog items matched your search filter.</div>
            )}
          </div>
        )}
      </div>

      {selectedProducts.length > 0 && (
        <div className="create-sale-summary">
          <strong>{selectedProducts.length}</strong> product{selectedProducts.length > 1 ? "s" : ""} configured:{" "}
          {selectedProducts.map((p) => p.name).join(", ")}
        </div>
      )}

      <div className="create-sale-actions">
        <button
          type="submit"
          className="admin-btn"
          disabled={isSubmitting}
          id="btn-create-flash-sale-submit"
        >
          {isSubmitting ? "Publishing Sale..." : "Schedule Flash Sale"}
        </button>
      </div>
    </form>
  );
}

// ─── Admin Panel (Tabbed, Executive Design) ──────────────────────────────────

type AdminTab = "overview" | "analytics" | "flash-sales";

function AdminPanel({
  token,
  products,
  onNotify,
}: {
  token: string;
  products: Product[];
  onNotify: (msg: string, type?: "success" | "error") => void;
}) {
  const [activeTab, setActiveTab] = useState<AdminTab>("overview");
  const [summary, setSummary] = useState<{
    products: number;
    orders: number;
    order_total_cents: number;
  } | null>(null);
  const [isRestocking, setIsRestocking] = useState(false);
  const [isCleaning, setIsCleaning] = useState(false);

  const fetchDashboard = useCallback(() => {
    fetch("/api/v1/admin/dashboard", { headers: { Authorization: `Bearer ${token}` } })
      .then((r) => (r.ok ? r.json() : null))
      .then(setSummary)
      .catch(() => setSummary(null));
  }, [token]);

  useEffect(() => { fetchDashboard(); }, [fetchDashboard]);

  const handleRestockAll = async () => {
    setIsRestocking(true);
    let ok = 0;
    try {
      for (const prod of products) {
        const key = `restock-${prod.id}-${Date.now()}`;
        const res = await fetch(`/api/v1/admin/products/${prod.id}/restock`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
          body: JSON.stringify({ quantity: 25, idempotency_key: key }),
        });
        if (res.ok) ok++;
      }
      onNotify(`Added +25 units to ${ok} product(s).`, "success");
      fetchDashboard();
    } catch {
      onNotify("Inventory restock failed.", "error");
    } finally {
      setIsRestocking(false);
    }
  };

  const handleCleanup = async () => {
    setIsCleaning(true);
    try {
      const res = await fetch("/api/v1/admin/reservations/cleanup", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.ok) {
        const d = await res.json();
        onNotify(`Reclaimed ${d.released_count} expired hold reservation(s).`, "success");
        fetchDashboard();
      } else {
        onNotify("Failed to release expired reservations.", "error");
      }
    } catch {
      onNotify("Network communication error while reclaiming holds.", "error");
    } finally {
      setIsCleaning(false);
    }
  };

  return (
    <div className="admin-page-container" id="admin-console">
      <div className="admin-console-header">
        <div>
          <span className="admin-eyebrow">Store Management</span>
          <h1 className="admin-main-title">Operations &amp; Analytics Console</h1>
          <p className="admin-subtitle">
            Catalog stock distribution, live flash sales, and order settlement velocity.
          </p>
        </div>
        <div className="admin-header-actions">
          <button className="admin-btn secondary" onClick={fetchDashboard} id="btn-refresh-admin">
            <IconRefresh />
            <span>Refresh State</span>
          </button>
        </div>
      </div>

      <div className="admin-tabs" role="tablist">
        <button
          role="tab"
          aria-selected={activeTab === "overview"}
          className={`admin-tab-btn ${activeTab === "overview" ? "active" : ""}`}
          onClick={() => setActiveTab("overview")}
          id="tab-admin-overview"
        >
          Overview
        </button>
        <button
          role="tab"
          aria-selected={activeTab === "analytics"}
          className={`admin-tab-btn ${activeTab === "analytics" ? "active" : ""}`}
          onClick={() => setActiveTab("analytics")}
          id="tab-admin-analytics"
        >
          Analytics &amp; Performance
        </button>
        <button
          role="tab"
          aria-selected={activeTab === "flash-sales"}
          className={`admin-tab-btn ${activeTab === "flash-sales" ? "active" : ""}`}
          onClick={() => setActiveTab("flash-sales")}
          id="tab-admin-flash-sales"
        >
          Flash Sales
        </button>
      </div>

      {activeTab === "overview" && (
        <div className="admin-pane" id="admin-overview-pane">
          <div className="admin-stats-grid">
            <div className="admin-stat-card">
              <span className="stat-label">Active Catalog Items</span>
              <div className="stat-value">{summary ? summary.products : products.length}</div>
              <span className="stat-sub">Available for retail checkout</span>
            </div>
            <div className="admin-stat-card">
              <span className="stat-label">Completed Orders</span>
              <div className="stat-value">{summary ? summary.orders : 0}</div>
              <span className="stat-sub">Paid &amp; confirmed orders</span>
            </div>
            <div className="admin-stat-card">
              <span className="stat-label">Total Sales Volume</span>
              <div className="stat-value">{summary ? formatCents(summary.order_total_cents) : "$0.00"}</div>
              <span className="stat-sub">Aggregated gross revenue</span>
            </div>
          </div>

          <div className="admin-maintenance-card">
            <div className="maintenance-info">
              <h3 className="maintenance-title">Inventory &amp; Reservation Maintenance</h3>
              <p className="maintenance-desc">
                Execute idempotent batch inventory additions or trigger immediate eviction of expired 10-minute cart holds. Automated system purge sweeps every 30 seconds.
              </p>
            </div>
            <div className="maintenance-actions">
              <button
                className="admin-btn"
                onClick={() => void handleRestockAll()}
                disabled={isRestocking}
                id="btn-restock-all"
              >
                {isRestocking ? "Restocking..." : "Restock All (+25 units)"}
              </button>
              <button
                className="admin-btn secondary"
                onClick={() => void handleCleanup()}
                disabled={isCleaning}
                id="btn-clean-holds"
              >
                {isCleaning ? "Reclaiming..." : "Release Expired Reservations"}
              </button>
            </div>
          </div>
        </div>
      )}

      {activeTab === "analytics" && <AnalyticsTab token={token} />}

      {activeTab === "flash-sales" && (
        <CreateFlashSaleTab token={token} onNotify={onNotify} />
      )}
    </div>
  );
}

// ─── Main App ────────────────────────────────────────────────────────────────

function App() {
  const [products, setProducts] = useState<Product[]>([]);
  const [cart, setCart] = useState<CartItem[]>([]);
  const [isCartOpen, setIsCartOpen] = useState(false);
  const [showAuthModal, setShowAuthModal] = useState(false);
  const [authTab, setAuthTab] = useState<"login" | "register">("login");
  const [showUserDropdown, setShowUserDropdown] = useState(false);
  const [completedOrder, setCompletedOrder] = useState<CompletedOrder | null>(null);
  const [session, setSession] = useState<Session | null>(null);

  // User delivery address management
  const [savedAddresses, setSavedAddresses] = useState<DeliveryAddress[]>(DEFAULT_SAVED_ADDRESSES);
  const [selectedAddressId, setSelectedAddressId] = useState<string>(DEFAULT_SAVED_ADDRESSES[0].id);
  const [showUserAddressDropdown, setShowUserAddressDropdown] = useState(false);
  const [showUserAddAddressForm, setShowUserAddAddressForm] = useState(false);
  const [newUserAddressDraft, setNewUserAddressDraft] = useState({ ...emptyAddressDraft });
  const [isDrawerAddressSelectorOpen, setIsDrawerAddressSelectorOpen] = useState(false);
  const [showDrawerAddAddressForm, setShowDrawerAddAddressForm] = useState(false);
  const [newDrawerAddressDraft, setNewDrawerAddressDraft] = useState({ ...emptyAddressDraft });

  // Storefront catalog search & category filtering
  const [catalogSearch, setCatalogSearch] = useState("");
  const [selectedCategory, setSelectedCategory] = useState<string>("All");

  // Dedicated View Mode: "store" or "admin"
  const [viewMode, setViewMode] = useState<"store" | "admin">(() => {
    if (typeof window !== "undefined") {
      const path = window.location.pathname;
      const hash = window.location.hash;
      if (path === "/admin" || hash === "#admin") return "admin";
    }
    return "store";
  });

  // Form states
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [authError, setAuthError] = useState("");
  const [isAuthenticating, setIsAuthenticating] = useState(false);

  const [recentlyAddedId, setRecentlyAddedId] = useState<string | null>(null);
  const [isCheckingOut, setIsCheckingOut] = useState(false);
  const [isScrolled, setIsScrolled] = useState(false);
  const [toasts, setToasts] = useState<Toast[]>([]);

  const [serverOffsetMs, setServerOffsetMs] = useState(0);
  const [heroCountdownSecs, setHeroCountdownSecs] = useState(28800);

  const dropdownRef = useRef<HTMLDivElement>(null);

  const totalItemsCount = useMemo(() => cart.reduce((s, i) => s + i.quantity, 0), [cart]);
  const totalPrice = useMemo(() => cart.reduce((s, i) => s + i.product.price * i.quantity, 0), [cart]);
  const cartSalePrice = useMemo(
    () =>
      cart.reduce(
        (s, i) => s + (i.product.salePrice !== undefined ? i.product.salePrice : i.product.price) * i.quantity,
        0
      ),
    [cart]
  );

  // Load and persist user delivery addresses per account
  useEffect(() => {
    const storageKey = `surgecart_saved_addresses_${session?.email || "guest"}`;
    try {
      const saved = localStorage.getItem(storageKey);
      if (saved) {
        const parsed = JSON.parse(saved) as DeliveryAddress[];
        if (Array.isArray(parsed) && parsed.length > 0) {
          setSavedAddresses(parsed);
          setSelectedAddressId(parsed[0].id);
          return;
        }
      }
      const initial = DEFAULT_SAVED_ADDRESSES.map((a) => ({
        ...a,
        fullName: session?.displayName || a.fullName,
      }));
      setSavedAddresses(initial);
      setSelectedAddressId(initial[0].id);
    } catch {
      // Fallback to default
    }
  }, [session]);

  const persistAddresses = (newList: DeliveryAddress[]) => {
    setSavedAddresses(newList);
    const storageKey = `surgecart_saved_addresses_${session?.email || "guest"}`;
    try {
      localStorage.setItem(storageKey, JSON.stringify(newList));
    } catch {
      // Non-blocking storage
    }
  };

  const activeAddress = useMemo(() => {
    return savedAddresses.find((a) => a.id === selectedAddressId) || savedAddresses[0] || DEFAULT_ADDRESS;
  }, [savedAddresses, selectedAddressId]);

  const handleAddAddress = (draft: Omit<DeliveryAddress, "id">) => {
    const newAddr: DeliveryAddress = {
      ...draft,
      id: `addr-${Date.now()}`,
      label: draft.label.trim() || "Address",
      fullName: draft.fullName.trim() || session?.displayName || "Customer",
    };
    const updated = [...savedAddresses, newAddr];
    persistAddresses(updated);
    setSelectedAddressId(newAddr.id);
    showToast(`Saved "${newAddr.label}" address.`, "success");
  };

  const handleDeleteAddress = (id: string) => {
    if (savedAddresses.length <= 1) {
      showToast("At least one delivery address is required.", "info");
      return;
    }
    const updated = savedAddresses.filter((a) => a.id !== id);
    persistAddresses(updated);
    if (selectedAddressId === id) {
      setSelectedAddressId(updated[0].id);
    }
    showToast("Address removed.", "info");
  };

  // Synchronize hash routing with viewMode
  const navigateTo = useCallback((mode: "store" | "admin") => {
    setViewMode(mode);
    if (mode === "admin") {
      window.history.pushState(null, "", "#admin");
    } else {
      window.history.pushState(null, "", "#drops");
    }
    window.scrollTo({ top: 0, behavior: "smooth" });
  }, []);

  useEffect(() => {
    const onHashChange = () => {
      if (window.location.hash === "#admin") {
        setViewMode("admin");
      } else if (
        window.location.hash === "" ||
        window.location.hash === "#top" ||
        window.location.hash === "#drops" ||
        window.location.hash === "#how"
      ) {
        setViewMode("store");
      }
    };
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  // ── Scroll header ──────────────────────────────────────────────────────
  useEffect(() => {
    const onScroll = () => setIsScrolled(window.scrollY > 20);
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  // Close dropdown on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setShowUserDropdown(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  // ── Sync server clock offset ───────────────────────────────────────────
  useEffect(() => {
    fetch("/api/v1/system/time")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (d?.server_time) {
          const serverMs = new Date(d.server_time).getTime();
          setServerOffsetMs(serverMs - Date.now());
        }
      })
      .catch(() => undefined);
  }, []);

  // ── Load products (enriched with flash sale context & remaining stock) ──
  const fetchProducts = useCallback(() => {
    fetch("/api/v1/products")
      .then((r) => (r.ok ? (r.json() as Promise<ApiProduct[]>) : Promise.reject()))
      .then((items) => {
        if (!items.length) return;
        const mapped: Product[] = items.map((item, idx) => {
          const enrich =
            uuidEnrichMap[item.id] ??
            enrichmentMap[item.sku] ??
            {};
          return {
            id: item.id,
            sku: item.sku,
            name: item.name,
            price: item.price_cents / 100,
            salePrice: item.flash_sale ? item.flash_sale.sale_price_cents / 100 : undefined,
            badge: item.flash_sale ? "Flash Deal" : idx === 0 ? "Featured Drop" : "Available Now",
            color: COLORS[idx % COLORS.length],
            imageUrl: enrich.imageUrl ?? `/products/${item.id}.jpg`,
            description: item.description ?? enrich.description ?? "Limited edition drop.",
            rating: enrich.rating ?? 4.5,
            reviewCount: enrich.reviewCount ?? 50,
            category: enrich.category ?? "Gear",
            availableQty: item.available_quantity,
            totalStock: enrich.totalStock ?? item.on_hand_quantity ?? 100,
            flashSale: item.flash_sale,
          };
        });
        setProducts(mapped);

        const liveEnds = mapped
          .filter((p) => p.flashSale)
          .map((p) => new Date(p.flashSale!.sale_ends_at).getTime());
        if (liveEnds.length > 0) {
          const earliest = Math.min(...liveEnds);
          const adjustedNow = Date.now() + serverOffsetMs;
          setHeroCountdownSecs(Math.max(0, Math.floor((earliest - adjustedNow) / 1000)));
        }
      })
      .catch(() => undefined);
  }, [serverOffsetMs]);

  useEffect(() => {
    fetchProducts();
  }, [fetchProducts]);

  // ── Hero countdown timer ───────────────────────────────────────────────
  useEffect(() => {
    const id = setInterval(
      () => setHeroCountdownSecs((p) => (p > 0 ? p - 1 : 0)),
      1000
    );
    return () => clearInterval(id);
  }, []);

  const formattedHeroCountdown = useMemo(() => fmtCountdown(heroCountdownSecs), [heroCountdownSecs]);

  // ── Toast helpers ──────────────────────────────────────────────────────
  const showToast = useCallback(
    (
      message: string,
      type: "success" | "error" | "info" = "info",
      actionLabel?: string,
      onAction?: () => void
    ) => {
      const id = Math.random().toString(36).slice(2, 9);
      setToasts((prev) => [...prev, { id, message, type, actionLabel, onAction }]);
      setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== id)), 4500);
    },
    []
  );

  // ── Cart actions ───────────────────────────────────────────────────────
  const addToBag = useCallback(
    (product: Product) => {
      setCart((prev) => {
        const existing = prev.find((i) => i.product.id === product.id);
        if (existing) return prev.map((i) => i.product.id === product.id ? { ...i, quantity: i.quantity + 1 } : i);
        return [...prev, { product, quantity: 1 }];
      });
      setRecentlyAddedId(product.id);
      setTimeout(() => setRecentlyAddedId(null), 1500);
      showToast(`${product.name} added to your bag`, "success", "View Bag", () => setIsCartOpen(true));
    },
    [showToast]
  );

  const updateQuantity = (productId: string, delta: number) => {
    setCart((prev) =>
      prev
        .map((i) => i.product.id === productId ? { ...i, quantity: i.quantity + delta } : i)
        .filter((i) => i.quantity > 0)
    );
  };

  const removeItem = (productId: string) => {
    setCart((prev) => prev.filter((i) => i.product.id !== productId));
    showToast("Item removed from bag");
  };

  // ── Checkout with Guaranteed Server Cart Synchronization ───────────────
  const handleCheckout = async () => {
    if (!cart.length) { showToast("Your bag is empty.", "info"); return; }
    setIsCheckingOut(true);
    try {
      // 1. Create a fresh dedicated checkout cart on the server
      const cartRes = await fetch("/api/v1/carts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      if (!cartRes.ok) throw new Error("Could not initialize checkout bag.");
      const cartData = await cartRes.json();
      const activeCartId: string = cartData.id;

      // 2. Synchronize all cart items into this active cart
      for (const item of cart) {
        const itemRes = await fetch(`/api/v1/carts/${activeCartId}/items`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            product_id: item.product.id,
            quantity: item.quantity,
            flash_sale_product_id: item.product.flashSale?.flash_sale_product_id ?? null,
          }),
        });
        if (!itemRes.ok) {
          const ed = await itemRes.json().catch(() => ({})) as { detail?: string };
          throw new Error(ed.detail ?? `Could not reserve ${item.product.name}.`);
        }
      }

      // 3. Complete checkout reservation
      const idempotencyKey = crypto.randomUUID?.() ?? `chk-${Date.now()}`;
      const orderRes = await fetch(`/api/v1/orders/checkout/${activeCartId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Idempotency-Key": idempotencyKey },
      });
      if (!orderRes.ok) {
        if (orderRes.status === 429) throw new Error("High checkout volume. Please retry in a few moments.");
        const ed = await orderRes.json().catch(() => ({})) as { detail?: string };
        throw new Error(ed.detail ?? "Stock hold could not be allocated.");
      }
      const order = await orderRes.json() as { id: string };

      // 4. Complete payment confirmation
      const payRes = await fetch(`/api/v1/orders/${order.id}/pay`, { method: "POST" });
      if (!payRes.ok) {
        const ed = await payRes.json().catch(() => ({})) as { detail?: string };
        throw new Error(ed.detail ?? "Payment authorization failed.");
      }
      const paid = await payRes.json() as { order_number: string; total_cents: number; currency: string };

      setCompletedOrder({
        orderNumber: paid.order_number,
        totalCents: paid.total_cents,
        currency: paid.currency,
        items: [...cart],
        deliveryAddress: { ...activeAddress },
      });
      setCart([]);
      setIsCartOpen(false);
      showToast(`Order ${paid.order_number} confirmed.`, "success");
      fetchProducts(); // Refresh stock metrics
    } catch (err: unknown) {
      const msg = (err as Error).message ?? "";
      const isNet = msg.includes("fetch") || msg.includes("Network") || msg.includes("Failed");
      showToast(isNet ? "Unable to reach checkout service." : msg || "Checkout transaction failed.", "error");
    } finally {
      setIsCheckingOut(false);
    }
  };

  // ── Auth ───────────────────────────────────────────────────────────────
  const handleAuth = async (event: FormEvent) => {
    event.preventDefault();
    setAuthError("");
    setIsAuthenticating(true);
    try {
      const endpoint = authTab === "login" ? "/api/v1/auth/login" : "/api/v1/auth/register";
      const body =
        authTab === "login"
          ? { email, password }
          : { email, password, display_name: displayName };
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({})) as { detail?: string };
        throw new Error(err.detail ?? (authTab === "login" ? "Incorrect email or password." : "Could not complete registration."));
      }
      const data = await res.json() as { access_token: string; user: { role: string; display_name: string; email: string } };
      setSession({ token: data.access_token, role: data.user.role, displayName: data.user.display_name, email: data.user.email });
      setShowAuthModal(false);
      showToast(authTab === "login" ? `Welcome back, ${data.user.display_name}.` : `Welcome to SurgeCart, ${data.user.display_name}.`, "success");
    } catch (err: unknown) {
      setAuthError((err as Error).message ?? "Authentication failed.");
    } finally {
      setIsAuthenticating(false);
    }
  };

  const scrollTo = (id: string) => {
    if (viewMode !== "store") {
      setViewMode("store");
      setTimeout(() => document.getElementById(id)?.scrollIntoView({ behavior: "smooth" }), 50);
    } else {
      document.getElementById(id)?.scrollIntoView({ behavior: "smooth" });
    }
  };

  // ── Filtered Products for Catalog Search ──────────────────────────────
  const categories = useMemo(() => {
    const set = new Set<string>();
    products.forEach((p) => { if (p.category) set.add(p.category); });
    return ["All", ...Array.from(set)];
  }, [products]);

  const filteredCatalogProducts = useMemo(() => {
    return products.filter((p) => {
      const matchSearch =
        p.name.toLowerCase().includes(catalogSearch.toLowerCase()) ||
        p.sku.toLowerCase().includes(catalogSearch.toLowerCase()) ||
        (p.description && p.description.toLowerCase().includes(catalogSearch.toLowerCase())) ||
        (p.category && p.category.toLowerCase().includes(catalogSearch.toLowerCase()));
      const matchCategory = selectedCategory === "All" || p.category === selectedCategory;
      return matchSearch && matchCategory;
    });
  }, [products, catalogSearch, selectedCategory]);

  const liveFlashSaleCount = products.filter((p) => p.flashSale).length;

  return (
    <>
      {/* ── Navigation Header ────────────────────────────────────────── */}
      <header className={`header-wrapper${isScrolled ? " header-scrolled" : ""}`}>
        <div className="nav">
          <div className="nav-brand-group">
            <a
              className="brand"
              href="#top"
              onClick={(e) => {
                e.preventDefault();
                navigateTo("store");
              }}
              id="brand-logo"
            >
              surge<span>cart</span>
            </a>
            {viewMode === "admin" && (
              <span className="brand-context-tag">Console</span>
            )}
          </div>

          <div className="nav-actions">
            {viewMode === "store" ? (
              <nav aria-label="Storefront navigation">
                <a href="#drops" onClick={(e) => { e.preventDefault(); scrollTo("drops"); }} id="nav-link-drops">
                  New Drops
                </a>
                {liveFlashSaleCount > 0 && (
                  <a href="#flash-sale-slider" onClick={(e) => { e.preventDefault(); scrollTo("flash-sale-slider"); }} className="nav-flash-badge" id="nav-link-flash">
                    {liveFlashSaleCount} Flash Sale{liveFlashSaleCount > 1 ? "s" : ""} Live
                  </a>
                )}
                <a href="#how" onClick={(e) => { e.preventDefault(); scrollTo("how"); }} id="nav-link-how">
                  How It Works
                </a>
                {session?.role === "admin" && (
                  <button className="admin-nav-badge" onClick={() => navigateTo("admin")} id="nav-link-admin">
                    Admin Console
                  </button>
                )}
              </nav>
            ) : (
              <nav aria-label="Admin console navigation">
                <button className="nav-store-return-btn" onClick={() => navigateTo("store")} id="btn-nav-return-store">
                  <span>&larr; View Storefront</span>
                </button>
              </nav>
            )}

            <div className="user-menu-container" ref={dropdownRef}>
              {session ? (
                <>
                  <button className="auth-button user-logged-pill" onClick={() => setShowUserDropdown((p) => !p)} id="user-profile-button">
                    <span className="user-avatar-initial">{session.displayName.charAt(0).toUpperCase()}</span>
                    <span>{session.displayName}</span>
                    <span style={{ fontSize: 9 }}>&#9660;</span>
                  </button>
                  {showUserDropdown && (
                    <div className="user-dropdown">
                      <div className="user-dropdown-header">
                        <div className="user-dropdown-name">{session.displayName}</div>
                        {session.email && <div className="user-dropdown-email">{session.email}</div>}
                      </div>

                      <div className="user-dropdown-section">
                        <button
                          type="button"
                          className="user-dropdown-section-toggle"
                          onClick={() => setShowUserAddressDropdown((p) => !p)}
                          id="btn-toggle-user-addresses"
                        >
                          <div className="toggle-left">
                            <IconPin />
                            <span>Delivery Address</span>
                          </div>
                          <span className="toggle-arrow" style={{ fontSize: 9 }}>
                            {showUserAddressDropdown ? "\u25B2" : "\u25BC"}
                          </span>
                        </button>

                        {showUserAddressDropdown && (
                          <div className="user-dropdown-address-list">
                            {savedAddresses.map((addr) => {
                              const isSelected = addr.id === activeAddress.id;
                              return (
                                <div
                                  key={addr.id}
                                  className={`user-address-card ${isSelected ? "selected" : ""}`}
                                  onClick={() => {
                                    setSelectedAddressId(addr.id);
                                    showToast(`Active address set to "${addr.label}".`, "info");
                                  }}
                                  id={`user-address-${addr.id}`}
                                >
                                  <div className="user-address-card-top">
                                    <span className="address-label-badge">{addr.label}</span>
                                    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                                      {isSelected && <span className="address-active-tag">Active</span>}
                                      {savedAddresses.length > 1 && (
                                        <button
                                          type="button"
                                          className="address-delete-btn"
                                          onClick={(e) => {
                                            e.stopPropagation();
                                            handleDeleteAddress(addr.id);
                                          }}
                                          title="Remove address"
                                          aria-label={`Remove ${addr.label} address`}
                                        >
                                          &times;
                                        </button>
                                      )}
                                    </div>
                                  </div>
                                  <div className="user-address-card-text">
                                    <strong>{addr.fullName}</strong>
                                    <div>{addr.street}</div>
                                    <div>{addr.city}, {addr.state} {addr.postalCode}</div>
                                  </div>
                                </div>
                              );
                            })}

                            {!showUserAddAddressForm ? (
                              <button
                                type="button"
                                className="user-add-address-trigger"
                                onClick={() => setShowUserAddAddressForm(true)}
                                id="btn-user-add-address-trigger"
                              >
                                + Add New Address
                              </button>
                            ) : (
                              <form
                                className="user-add-address-form"
                                onSubmit={(e) => {
                                  e.preventDefault();
                                  handleAddAddress(newUserAddressDraft);
                                  setShowUserAddAddressForm(false);
                                  setNewUserAddressDraft({ ...emptyAddressDraft, fullName: session?.displayName || "" });
                                }}
                                id="form-user-add-address"
                              >
                                <div className="form-title">New Address</div>
                                <label className="address-form-label">
                                  Label
                                  <input
                                    type="text"
                                    required
                                    placeholder="e.g. Home, Office, Studio"
                                    value={newUserAddressDraft.label}
                                    onChange={(e) => setNewUserAddressDraft({ ...newUserAddressDraft, label: e.target.value })}
                                    className="address-input"
                                    id="input-user-new-addr-label"
                                  />
                                </label>
                                <label className="address-form-label">
                                  Full Name
                                  <input
                                    type="text"
                                    required
                                    placeholder="Full name"
                                    value={newUserAddressDraft.fullName}
                                    onChange={(e) => setNewUserAddressDraft({ ...newUserAddressDraft, fullName: e.target.value })}
                                    className="address-input"
                                    id="input-user-new-addr-name"
                                  />
                                </label>
                                <label className="address-form-label">
                                  Street Address
                                  <input
                                    type="text"
                                    required
                                    placeholder="Street and apt/suite"
                                    value={newUserAddressDraft.street}
                                    onChange={(e) => setNewUserAddressDraft({ ...newUserAddressDraft, street: e.target.value })}
                                    className="address-input"
                                    id="input-user-new-addr-street"
                                  />
                                </label>
                                <div className="address-form-grid">
                                  <label className="address-form-label">
                                    City
                                    <input
                                      type="text"
                                      required
                                      placeholder="City"
                                      value={newUserAddressDraft.city}
                                      onChange={(e) => setNewUserAddressDraft({ ...newUserAddressDraft, city: e.target.value })}
                                      className="address-input"
                                      id="input-user-new-addr-city"
                                    />
                                  </label>
                                  <label className="address-form-label">
                                    State
                                    <input
                                      type="text"
                                      required
                                      placeholder="State"
                                      value={newUserAddressDraft.state}
                                      onChange={(e) => setNewUserAddressDraft({ ...newUserAddressDraft, state: e.target.value })}
                                      className="address-input"
                                      id="input-user-new-addr-state"
                                    />
                                  </label>
                                </div>
                                <div className="address-form-grid">
                                  <label className="address-form-label">
                                    Postal Code
                                    <input
                                      type="text"
                                      required
                                      placeholder="ZIP"
                                      value={newUserAddressDraft.postalCode}
                                      onChange={(e) => setNewUserAddressDraft({ ...newUserAddressDraft, postalCode: e.target.value })}
                                      className="address-input"
                                      id="input-user-new-addr-zip"
                                    />
                                  </label>
                                  <label className="address-form-label">
                                    Country
                                    <input
                                      type="text"
                                      required
                                      placeholder="Country"
                                      value={newUserAddressDraft.country}
                                      onChange={(e) => setNewUserAddressDraft({ ...newUserAddressDraft, country: e.target.value })}
                                      className="address-input"
                                      id="input-user-new-addr-country"
                                    />
                                  </label>
                                </div>
                                <div className="address-form-actions">
                                  <button type="submit" className="address-save-btn" id="btn-user-submit-new-address">
                                    Save Address
                                  </button>
                                  <button
                                    type="button"
                                    className="address-cancel-btn"
                                    onClick={() => setShowUserAddAddressForm(false)}
                                  >
                                    Cancel
                                  </button>
                                </div>
                              </form>
                            )}
                          </div>
                        )}
                      </div>
                      {session.role === "admin" && (
                        <button
                          className="user-dropdown-item"
                          onClick={() => {
                            setShowUserDropdown(false);
                            navigateTo(viewMode === "admin" ? "store" : "admin");
                          }}
                          id="btn-goto-admin"
                        >
                          {viewMode === "admin" ? "View Storefront" : "Admin Console"}
                        </button>
                      )}
                      <button
                        className="user-dropdown-item logout"
                        onClick={() => {
                          setSession(null);
                          setShowUserDropdown(false);
                          showToast("Signed out successfully.");
                          if (viewMode === "admin") navigateTo("store");
                        }}
                        id="btn-sign-out"
                      >
                        Sign Out
                      </button>
                    </div>
                  )}
                </>
              ) : (
                <button className="auth-button" onClick={() => { setAuthError(""); setShowAuthModal(true); }} id="btn-open-login">
                  Sign In
                </button>
              )}
            </div>

            {viewMode === "store" && (
              <button className="bag" onClick={() => setIsCartOpen(true)} id="btn-toggle-bag">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M6 2L3 6v14a2 2 0 002 2h14a2 2 0 002-2V6l-3-4z" />
                  <line x1="3" y1="6" x2="21" y2="6" />
                  <path d="M16 10a4 4 0 01-8 0" />
                </svg>
                {totalItemsCount > 0 && <b>{totalItemsCount}</b>}
              </button>
            )}
          </div>
        </div>
      </header>

      {/* ── Main View Router ────────────────────────────────────────── */}
      <main id="top">
        {viewMode === "admin" ? (
          session?.role === "admin" ? (
            <AdminPanel token={session.token} products={products} onNotify={showToast} />
          ) : (
            <div className="admin-auth-guard">
              <div className="guard-card">
                <span className="admin-eyebrow">Access Restricted</span>
                <h2>Admin Console</h2>
                <p>An administrator session is required to inspect performance metrics and configure flash sales.</p>
                <button
                  className="admin-btn"
                  onClick={() => {
                    setAuthError("");
                    setAuthTab("login");
                    setShowAuthModal(true);
                  }}
                  id="btn-guard-login"
                >
                  Sign In as Administrator
                </button>
                <button className="inline-link" style={{ marginTop: 12 }} onClick={() => navigateTo("store")}>
                  Return to Storefront
                </button>
              </div>
            </div>
          )
        ) : (
          /* ── STOREFRONT VIEW ── */
          <>
            {/* Hero Section */}
            <section className="hero">
              <div className="hero-text">
                <p className="eyebrow">TODAY'S FEATURED DROP</p>
                <h1>
                  Limited goods.<br />
                  <em>Fair access.</em>
                </h1>
                <p className="hero-copy">
                  Curated products released in small batches. Every checkout is protected with
                  row-level stock locks &mdash; first to confirm, first to own.
                </p>
                <div className="hero-actions">
                  <button className="button" onClick={() => scrollTo("drops")} id="btn-shop-drop-hero">
                    Shop the Drop <span>&rarr;</span>
                  </button>
                  <button className="button-ghost" onClick={() => scrollTo("how")} id="btn-how-hero">
                    How it works
                  </button>
                </div>
                <div className="trust-row">
                  <span className="trust-item">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"><path d="M5 12h14M12 5l7 7-7 7" /></svg>
                    Free shipping over $75
                  </span>
                  <span className="trust-item">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" /></svg>
                    Secure checkout
                  </span>
                  <span className="trust-item">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"><path d="M21 10c0 7-9 13-9 13S3 17 3 10a9 9 0 0118 0z" /><circle cx="12" cy="10" r="3" /></svg>
                    Ships worldwide
                  </span>
                </div>
              </div>

              {/* Hero countdown card */}
              <div className="hero-card" onClick={() => scrollTo("drops")} title="View today's drops" id="hero-drop-card">
                <div className="hero-card-header">
                  <span className="hero-card-tag">
                    {liveFlashSaleCount > 0 ? `${liveFlashSaleCount} SALE${liveFlashSaleCount > 1 ? "S" : ""} LIVE` : "DROP 07"}
                  </span>
                  <span className="hero-card-pulse" />
                </div>
                <div className="hero-card-body">
                  <p className="hero-card-label">{liveFlashSaleCount > 0 ? "Flash sale ends in" : "Sale ends in"}</p>
                  <strong>{formattedHeroCountdown}</strong>
                  <div className="hero-card-caption">
                    <span>Limited stock &mdash; act fast</span>
                    <span className="hero-card-link">Browse &rarr;</span>
                  </div>
                </div>
                <div className="orb" />
              </div>
            </section>

            {/* ── Neat Interactive Sleek Separate Slider for Items Currently in Sale ── */}
            <FlashSaleSlider
              products={products}
              serverOffsetMs={serverOffsetMs}
              onAddToBag={addToBag}
              recentlyAddedId={recentlyAddedId}
            />

            {/* Products Catalog */}
            <section id="drops" className="products">
              <div className="section-heading">
                <div>
                  <p className="eyebrow">CATALOG RELEASES</p>
                  <h2>This week's drops.</h2>
                </div>
                <p>Every item ships in limited quantities. Once the allocation is gone, it's gone for good.</p>
              </div>

              {/* Product Search & Category Filter Toolbar */}
              <div className="catalog-search-toolbar">
                <div className="catalog-search-row">
                  <div className="catalog-search-input-wrap">
                    <span className="catalog-search-icon"><IconSearch /></span>
                    <input
                      type="search"
                      value={catalogSearch}
                      onChange={(e) => setCatalogSearch(e.target.value)}
                      placeholder="Search releases by name, category, or SKU..."
                      className="catalog-search-input"
                      id="input-catalog-search"
                    />
                    {catalogSearch && (
                      <button
                        type="button"
                        onClick={() => setCatalogSearch("")}
                        className="catalog-search-clear"
                        aria-label="Clear search"
                      >
                        &times;
                      </button>
                    )}
                  </div>

                  <div className="catalog-filter-pills">
                    {categories.map((cat) => (
                      <button
                        key={cat}
                        className={`filter-pill ${selectedCategory === cat ? "active" : ""}`}
                        onClick={() => setSelectedCategory(cat)}
                        id={`filter-pill-${cat.toLowerCase()}`}
                      >
                        {cat}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="catalog-results-info">
                  <span>
                    Showing {filteredCatalogProducts.length} product{filteredCatalogProducts.length !== 1 ? "s" : ""}
                    {catalogSearch ? ` matching "${catalogSearch}"` : ""}
                    {selectedCategory !== "All" ? ` in ${selectedCategory}` : ""}
                  </span>
                  {(catalogSearch || selectedCategory !== "All") && (
                    <button
                      className="inline-link"
                      onClick={() => {
                        setCatalogSearch("");
                        setSelectedCategory("All");
                      }}
                    >
                      Reset filters
                    </button>
                  )}
                </div>
              </div>

              <div className="grid">
                {filteredCatalogProducts.map((product, idx) => {
                  const isAdded = recentlyAddedId === product.id;
                  const isFlash = !!product.flashSale;
                  const remaining = isFlash ? product.flashSale!.units_remaining : product.availableQty;
                  const total = isFlash ? product.flashSale!.allocation_quantity : product.totalStock;
                  const isOut = remaining === 0;

                  return (
                    <article
                      key={product.id}
                      className={`product ${isFlash ? "product--flash" : ""}`}
                      id={`product-card-${product.id}`}
                    >
                      <div className="product-image-wrap">
                        {product.imageUrl ? (
                          <img src={product.imageUrl} alt={product.name} className="product-img" loading={idx < 3 ? "eager" : "lazy"} />
                        ) : (
                          <div className={`product-image-fallback ${product.color}`}>
                            <div className="shape" />
                          </div>
                        )}

                        {isFlash && (
                          <div className="flash-ribbon" aria-label="Flash sale">
                            FLASH SALE
                          </div>
                        )}

                        <span className={`product-badge ${isFlash ? "flash" : ""}`}>{product.badge}</span>
                        {product.category && (
                          <span className="product-category">{product.category}</span>
                        )}
                      </div>

                      <div className="product-body">
                        <div className="product-meta">
                          {product.rating !== undefined && (
                            <div className="product-rating">
                              <StarRating rating={product.rating} />
                              <span className="review-count">({product.reviewCount})</span>
                            </div>
                          )}
                          <h3 className="product-name">{product.name}</h3>
                          {product.description && <p className="product-desc">{product.description}</p>}
                        </div>

                        <div className="product-footer">
                          {isFlash && product.flashSale && (
                            <FlashCountdown
                              endsAt={product.flashSale.sale_ends_at}
                              serverOffsetMs={serverOffsetMs}
                            />
                          )}

                          {/* Displays exact units remaining for sale if flash item, or catalog stock */}
                          <StockBar
                            available={remaining}
                            total={total}
                            isFlashSale={isFlash}
                          />

                          <div className="product-price-row">
                            <div className="product-price-group">
                              {isFlash && product.salePrice !== undefined ? (
                                <>
                                  <span className="product-price flash">{formatPrice(product.salePrice)}</span>
                                  <span className="product-price-original">{formatPrice(product.price)}</span>
                                </>
                              ) : (
                                <span className="product-price">{formatPrice(product.price)}</span>
                              )}
                            </div>
                            <button
                              className={`product-add-btn ${isAdded ? "added" : ""} ${isFlash ? "flash-btn" : ""}`}
                              onClick={() => !isOut && void addToBag(product)}
                              disabled={isOut}
                              id={`btn-add-${product.id}`}
                              aria-label={`Add ${product.name} to bag`}
                            >
                              {isOut ? "Sold Out" : isAdded ? "Added" : "Add to Bag"}
                            </button>
                          </div>
                        </div>
                      </div>
                    </article>
                  );
                })}

                {filteredCatalogProducts.length === 0 && (
                  <div className="catalog-empty-search">
                    <h3>No releases found</h3>
                    <p>We couldn't find any products matching your current search terms.</p>
                    <button
                      className="button"
                      onClick={() => {
                        setCatalogSearch("");
                        setSelectedCategory("All");
                      }}
                    >
                      View All Catalog Items
                    </button>
                  </div>
                )}
              </div>
            </section>

            {/* How It Works */}
            <section id="how" className="steps">
              <div className="steps-inner">
                <div className="steps-header">
                  <p className="eyebrow" style={{ color: "#9dc9a8" }}>HOW IT WORKS</p>
                  <h2>Fair drops for<br /><em>real people.</em></h2>
                  <p className="steps-sub">We built SurgeCart so bots can't win. Every checkout is fair, transparent, and fast.</p>
                </div>
                <div className="step-grid">
                  <div className="step-card">
                    <div className="step-icon"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" /></svg></div>
                    <h4>Browse openly</h4>
                    <p>Stock levels are visible before you buy. No hidden queues, no false scarcity messaging.</p>
                  </div>
                  <div className="step-card">
                    <div className="step-icon"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="11" width="18" height="11" rx="2" ry="2" /><path d="M7 11V7a5 5 0 0110 0v4" /></svg></div>
                    <h4>Your item is held</h4>
                    <p>When you check out, your stock is locked with a database-level row lock for 10 minutes while you pay.</p>
                  </div>
                  <div className="step-card">
                    <div className="step-icon"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12" /></svg></div>
                    <h4>Instant confirmation</h4>
                    <p>Payment confirms and commits inventory atomically. You get an order number immediately.</p>
                  </div>
                </div>
              </div>
            </section>

            {/* Checkout Banner */}
            <section className="checkout-banner" id="checkout-summary">
              <div>
                <p className="eyebrow">YOUR BAG</p>
                <h2>
                  {totalItemsCount > 0
                    ? `${totalItemsCount} item${totalItemsCount > 1 ? "s" : ""} \u00B7 ${formatPrice(cartSalePrice)}`
                    : "Your bag is empty."}
                </h2>
                <p className="fine" style={{ margin: "4px 0 0" }}>
                  {totalItemsCount > 0 ? `Delivering to ${activeAddress.city}, ${activeAddress.state}. Complete checkout to lock your stock.` : "Explore this week's drops above."}
                </p>
              </div>
              <div className="checkout-banner-actions">
                {totalItemsCount > 0 && (
                  <button className="button-outline" onClick={() => setIsCartOpen(true)} id="btn-view-bag-bottom">
                    View Bag ({totalItemsCount})
                  </button>
                )}
                <button className="button" onClick={() => void handleCheckout()} disabled={isCheckingOut || totalItemsCount === 0} id="btn-checkout-bottom">
                  {isCheckingOut ? "Reserving..." : "Checkout"} <span>&rarr;</span>
                </button>
              </div>
            </section>
          </>
        )}
      </main>

      {/* ── Footer ──────────────────────────────────────────────────── */}
      <footer>
        <div className="footer-brand-col">
          <a className="brand" href="#top" onClick={(e) => { e.preventDefault(); navigateTo("store"); }} id="footer-brand">
            surge<span>cart</span>
          </a>
          <p className="footer-tagline">Limited drops, fairly sold.</p>
        </div>
        <div className="footer-links">
          <div className="footer-link-group">
            <strong>Shop</strong>
            <a href="#drops" onClick={(e) => { e.preventDefault(); scrollTo("drops"); }}>New Drops</a>
            <a href="#how" onClick={(e) => { e.preventDefault(); scrollTo("how"); }}>How It Works</a>
          </div>
          <div className="footer-link-group">
            <strong>Support</strong>
            <a href="mailto:hello@surgecart.local" id="footer-contact">Contact Us</a>
            <a href="#faq">Returns &amp; Exchanges</a>
            <a href="#faq">Shipping Info</a>
          </div>
        </div>
        <div className="footer-bottom">
          <span>&copy; 2025 SurgeCart. All rights reserved.</span>
          <span><a href="#privacy">Privacy Policy</a> &middot; <a href="#terms">Terms of Use</a></span>
        </div>
      </footer>

      {/* ── Cart Drawer ──────────────────────────────────────────────── */}
      {isCartOpen && (
        <div className="drawer-backdrop" onClick={() => setIsCartOpen(false)} role="presentation">
          <div className="cart-drawer" onClick={(e) => e.stopPropagation()} id="cart-drawer">
            <div className="drawer-header">
              <h2>Your Bag {totalItemsCount > 0 && <span>({totalItemsCount})</span>}</h2>
              <button className="close-btn" onClick={() => setIsCartOpen(false)} aria-label="Close cart drawer" id="btn-close-drawer">
                &times;
              </button>
            </div>

            {cart.length === 0 ? (
              <div className="drawer-empty">
                <div className="drawer-empty-icon">
                  <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M6 2L3 6v14a2 2 0 002 2h14a2 2 0 002-2V6l-3-4z" /><line x1="3" y1="6" x2="21" y2="6" /><path d="M16 10a4 4 0 01-8 0" /></svg>
                </div>
                <h3>Your bag is empty</h3>
                <p>Explore this week's limited drops and add something before it sells out.</p>
                <button className="button" onClick={() => { setIsCartOpen(false); scrollTo("drops"); }} id="btn-drawer-explore">
                  Explore Drops <span>&rarr;</span>
                </button>
              </div>
            ) : (
              <>
                <div className="drawer-items">
                  {cart.map((item) => {
                    const effectivePrice = item.product.salePrice !== undefined ? item.product.salePrice : item.product.price;
                    return (
                      <div className="cart-item" key={item.product.id}>
                        <div className="cart-item-thumb">
                          {item.product.imageUrl ? (
                            <img src={item.product.imageUrl} alt={item.product.name} />
                          ) : (
                            <div className={`cart-item-thumb-fallback ${item.product.color}`} />
                          )}
                        </div>
                        <div className="cart-item-details">
                          <div className="cart-item-title">
                            {item.product.name}
                            {item.product.flashSale && <span className="cart-item-flash-tag">Flash Sale</span>}
                          </div>
                          <div className="cart-item-price">
                            {item.product.salePrice !== undefined && (
                              <span className="cart-item-original">{formatPrice(item.product.price)}</span>
                            )}
                            {formatPrice(effectivePrice)}
                          </div>
                        </div>
                        <div className="cart-qty-controls">
                          <button className="cart-qty-btn" onClick={() => updateQuantity(item.product.id, -1)} aria-label="Decrease quantity" id={`btn-qty-minus-${item.product.id}`}>&minus;</button>
                          <span className="cart-qty-val">{item.quantity}</span>
                          <button className="cart-qty-btn" onClick={() => updateQuantity(item.product.id, 1)} aria-label="Increase quantity" id={`btn-qty-plus-${item.product.id}`}>+</button>
                        </div>
                        <button className="cart-item-remove" onClick={() => removeItem(item.product.id)} aria-label="Remove item" title="Remove" id={`btn-remove-${item.product.id}`}>&times;</button>
                      </div>
                    );
                  })}
                </div>

                <div className="drawer-footer">
                  {/* Stock lock alert */}
                  <div className="drawer-hold-card" id="drawer-hold-card">
                    <div className="drawer-hold-badge">
                      <span className="drawer-hold-pulse" aria-hidden="true" />
                      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="3" y="11" width="18" height="11" rx="2" ry="2" /><path d="M7 11V7a5 5 0 0 1 10 0v4" /></svg>
                    </div>
                    <div className="drawer-hold-text">
                      <div className="drawer-hold-title">Stock reserved for 10 minutes</div>
                      <div className="drawer-hold-subtitle">Allocation is locked during checkout</div>
                    </div>
                  </div>

                  {/* ── User Delivery Address Card with Saved Address Selector ── */}
                  <div className="drawer-address-card" id="drawer-delivery-address-card">
                    <div className="drawer-address-header">
                      <div className="drawer-address-title">
                        <IconPin />
                        <span>Delivery Destination</span>
                      </div>
                      <button
                        type="button"
                        className="drawer-address-toggle"
                        onClick={() => setIsDrawerAddressSelectorOpen((p) => !p)}
                        id="btn-toggle-address-edit"
                      >
                        {isDrawerAddressSelectorOpen ? "Done" : "Change"}
                      </button>
                    </div>

                    {!isDrawerAddressSelectorOpen ? (
                      <div className="drawer-address-summary">
                        <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 3 }}>
                          <span className="address-label-badge">{activeAddress.label}</span>
                          <span className="drawer-address-name">{activeAddress.fullName}</span>
                        </div>
                        <div>{activeAddress.street}</div>
                        <div>{activeAddress.city}, {activeAddress.state} {activeAddress.postalCode}</div>
                      </div>
                    ) : (
                      <div className="drawer-address-selection-container">
                        <div className="drawer-address-choose-hint">Choose delivery address for checkout:</div>
                        <div className="drawer-address-options">
                          {savedAddresses.map((addr) => {
                            const isSelected = addr.id === activeAddress.id;
                            return (
                              <div
                                key={addr.id}
                                className={`drawer-address-option ${isSelected ? "active" : ""}`}
                                onClick={() => {
                                  setSelectedAddressId(addr.id);
                                  setIsDrawerAddressSelectorOpen(false);
                                  showToast(`Delivery destination set to "${addr.label}".`, "info");
                                }}
                                id={`drawer-address-opt-${addr.id}`}
                              >
                                <div className="option-radio-ring">
                                  {isSelected && <div className="option-radio-dot" />}
                                </div>
                                <div className="option-content">
                                  <div className="option-title-row">
                                    <span className="address-label-badge">{addr.label}</span>
                                    <strong style={{ color: "var(--forest)" }}>{addr.fullName}</strong>
                                    {isSelected && <span className="address-active-tag" style={{ marginLeft: "auto" }}>Selected</span>}
                                  </div>
                                  <div className="option-address-text">
                                    {addr.street}, {addr.city}, {addr.state} {addr.postalCode}
                                  </div>
                                </div>
                              </div>
                            );
                          })}
                        </div>

                        {!showDrawerAddAddressForm ? (
                          <button
                            type="button"
                            className="drawer-add-address-trigger"
                            onClick={() => setShowDrawerAddAddressForm(true)}
                            id="btn-drawer-add-address-trigger"
                          >
                            + Add New Address
                          </button>
                        ) : (
                          <form
                            className="drawer-address-form"
                            onSubmit={(e) => {
                              e.preventDefault();
                              handleAddAddress(newDrawerAddressDraft);
                              setShowDrawerAddAddressForm(false);
                              setNewDrawerAddressDraft({ ...emptyAddressDraft, fullName: session?.displayName || "" });
                            }}
                            id="form-drawer-add-address"
                          >
                            <div className="form-title">New Delivery Address</div>
                            <label className="address-form-label">
                              Label
                              <input
                                type="text"
                                required
                                placeholder="e.g. Home, Office, Studio"
                                value={newDrawerAddressDraft.label}
                                onChange={(e) => setNewDrawerAddressDraft({ ...newDrawerAddressDraft, label: e.target.value })}
                                className="address-input"
                                id="input-drawer-new-label"
                              />
                            </label>
                            <label className="address-form-label">
                              Full Name
                              <input
                                type="text"
                                required
                                placeholder="Full name"
                                value={newDrawerAddressDraft.fullName}
                                onChange={(e) => setNewDrawerAddressDraft({ ...newDrawerAddressDraft, fullName: e.target.value })}
                                className="address-input"
                                id="input-drawer-new-fullname"
                              />
                            </label>
                            <label className="address-form-label">
                              Street Address
                              <input
                                type="text"
                                required
                                placeholder="Street and apt/suite"
                                value={newDrawerAddressDraft.street}
                                onChange={(e) => setNewDrawerAddressDraft({ ...newDrawerAddressDraft, street: e.target.value })}
                                className="address-input"
                                id="input-drawer-new-street"
                              />
                            </label>
                            <div className="address-form-grid">
                              <label className="address-form-label">
                                City
                                <input
                                  type="text"
                                  required
                                  placeholder="City"
                                  value={newDrawerAddressDraft.city}
                                  onChange={(e) => setNewDrawerAddressDraft({ ...newDrawerAddressDraft, city: e.target.value })}
                                  className="address-input"
                                  id="input-drawer-new-city"
                                />
                              </label>
                              <label className="address-form-label">
                                State
                                <input
                                  type="text"
                                  required
                                  placeholder="State"
                                  value={newDrawerAddressDraft.state}
                                  onChange={(e) => setNewDrawerAddressDraft({ ...newDrawerAddressDraft, state: e.target.value })}
                                  className="address-input"
                                  id="input-drawer-new-state"
                                />
                              </label>
                            </div>
                            <div className="address-form-grid">
                              <label className="address-form-label">
                                Postal Code
                                <input
                                  type="text"
                                  required
                                  placeholder="ZIP"
                                  value={newDrawerAddressDraft.postalCode}
                                  onChange={(e) => setNewDrawerAddressDraft({ ...newDrawerAddressDraft, postalCode: e.target.value })}
                                  className="address-input"
                                  id="input-drawer-new-zip"
                                />
                              </label>
                              <label className="address-form-label">
                                Country
                                <input
                                  type="text"
                                  required
                                  placeholder="Country"
                                  value={newDrawerAddressDraft.country}
                                  onChange={(e) => setNewDrawerAddressDraft({ ...newDrawerAddressDraft, country: e.target.value })}
                                  className="address-input"
                                  id="input-drawer-new-country"
                                />
                              </label>
                            </div>
                            <div className="address-form-actions">
                              <button type="submit" className="address-save-btn" id="btn-save-drawer-address">
                                Save &amp; Select
                              </button>
                              <button
                                type="button"
                                className="address-cancel-btn"
                                onClick={() => setShowDrawerAddAddressForm(false)}
                              >
                                Cancel
                              </button>
                            </div>
                          </form>
                        )}
                      </div>
                    )}
                  </div>

                  {totalPrice !== cartSalePrice && (
                    <div className="drawer-summary-row discount">
                      <span>Flash Sale Discount</span>
                      <span className="discount-amount">&minus;{formatPrice(totalPrice - cartSalePrice)}</span>
                    </div>
                  )}
                  <div className="drawer-summary-row">
                    <span>Subtotal</span>
                    <span>{formatPrice(cartSalePrice)}</span>
                  </div>
                  <div className="drawer-summary-row">
                    <span>Shipping</span>
                    <span style={{ color: "var(--terracotta)", fontWeight: 600 }}>Free</span>
                  </div>
                  <div className="drawer-summary-row total">
                    <span>Estimated Total</span>
                    <span>{formatPrice(cartSalePrice)}</span>
                  </div>
                  <button className="button drawer-checkout-btn" onClick={() => void handleCheckout()} disabled={isCheckingOut} id="btn-drawer-checkout">
                    {isCheckingOut ? "Reserving & Authorizing..." : "Complete Checkout"} <span>&rarr;</span>
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {/* ── Auth Modal ──────────────────────────────────────────────── */}
      {showAuthModal && (
        <div className="dialog-backdrop" onClick={() => setShowAuthModal(false)} role="presentation">
          <form className="dialog" onSubmit={(e) => void handleAuth(e)} onClick={(e) => e.stopPropagation()} id="auth-form">
            <button type="button" className="close-btn" onClick={() => setShowAuthModal(false)} aria-label="Close dialog" id="btn-close-auth">&times;</button>
            <p className="eyebrow">{authTab === "login" ? "WELCOME BACK" : "JOIN SURGECART"}</p>
            <h2>{authTab === "login" ? "Sign In" : "Create Account"}</h2>

            <div className="dialog-tabs">
              <button type="button" className={`dialog-tab ${authTab === "login" ? "active" : ""}`} onClick={() => { setAuthTab("login"); setAuthError(""); }} id="tab-auth-login">Log In</button>
              <button type="button" className={`dialog-tab ${authTab === "register" ? "active" : ""}`} onClick={() => { setAuthTab("register"); setAuthError(""); }} id="tab-auth-register">Create Account</button>
            </div>

            {authError && <div className="dialog-error">{authError}</div>}

            {authTab === "register" && (
              <label>Full Name<input required type="text" value={displayName} onChange={(e) => setDisplayName(e.target.value)} placeholder="Alex Morgan" id="input-auth-name" /></label>
            )}
            <label>Email Address<input required type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" id="input-auth-email" /></label>
            <label>Password<input required type="password" minLength={8} value={password} onChange={(e) => setPassword(e.target.value)} placeholder="At least 8 characters" id="input-auth-password" /></label>

            <button className="button" type="submit" disabled={isAuthenticating} id="btn-auth-submit">
              {isAuthenticating ? "Processing..." : authTab === "login" ? "Sign In" : "Create Account"} <span>&rarr;</span>
            </button>

            {authTab === "login" && (
              <div className="demo-account-hint">
                <div>
                  <strong>Admin demo account:</strong>
                  <div style={{ color: "var(--color-text-muted)", marginTop: 2 }}>admin@surgecart.local</div>
                </div>
                <button type="button" onClick={() => { setEmail("admin@surgecart.local"); setPassword("change-this-password"); setAuthTab("login"); }} id="btn-quick-fill-admin">
                  Fill Credentials
                </button>
              </div>
            )}
          </form>
        </div>
      )}

      {/* ── Order Confirmation Modal ─────────────────────────────────── */}
      {completedOrder && (
        <div className="dialog-backdrop" onClick={() => setCompletedOrder(null)} role="presentation">
          <div className="dialog order-success-card" onClick={(e) => e.stopPropagation()} id="order-success-modal">
            <div className="order-success-icon"><IconCheck /></div>
            <p className="eyebrow">ORDER CONFIRMED</p>
            <h2>Thank you!</h2>
            <p className="hero-copy" style={{ margin: "8px auto 16px", fontSize: 15 }}>
              Your allocation has been locked and confirmed. A confirmation receipt has been issued.
            </p>
            <div className="order-success-number">{completedOrder.orderNumber}</div>

            {completedOrder.deliveryAddress && (
              <div className="order-delivery-block">
                <div className="order-delivery-title">Delivery Destination &bull; {completedOrder.deliveryAddress.label}</div>
                <div className="order-delivery-text">
                  {completedOrder.deliveryAddress.fullName} &bull; {completedOrder.deliveryAddress.street}, {completedOrder.deliveryAddress.city}, {completedOrder.deliveryAddress.state} {completedOrder.deliveryAddress.postalCode}
                </div>
              </div>
            )}

            <div className="order-success-details">
              <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 8 }}>
                <span>Total Paid:</span>
                <b>{formatCents(completedOrder.totalCents)}</b>
              </div>
              <div style={{ display: "flex", justifyContent: "space-between" }}>
                <span>Payment:</span>
                <span style={{ color: "var(--terracotta)", fontWeight: 600 }}>Demo Verified</span>
              </div>
            </div>
            <button className="button" style={{ width: "100%" }} onClick={() => setCompletedOrder(null)} id="btn-order-continue-shopping">
              Continue Shopping <span>&rarr;</span>
            </button>
          </div>
        </div>
      )}

      {/* ── Toast Notifications ──────────────────────────────────────── */}
      <div className="toast-container" aria-live="polite">
        {toasts.map((toast) => (
          <div className={`toast toast-${toast.type ?? "info"}`} key={toast.id}>
            <div className="toast-content">
              <span className="toast-icon">
                {toast.type === "error" ? <IconAlert /> : toast.type === "success" ? <IconCheck /> : <IconInfo />}
              </span>
              <span>{toast.message}</span>
            </div>
            {toast.actionLabel && toast.onAction && (
              <button className="toast-action" onClick={() => { toast.onAction?.(); setToasts((p) => p.filter((t) => t.id !== toast.id)); }}>
                {toast.actionLabel}
              </button>
            )}
          </div>
        ))}
      </div>
    </>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
