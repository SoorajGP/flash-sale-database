import { FormEvent, useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";

type Product = {
  id: string;
  name: string;
  price: number;
  badge: string;
  color: string;
  stock?: number;
  // enriched UI fields (fallback only)
  imageUrl?: string;
  description?: string;
  rating?: number;
  reviewCount?: number;
  category?: string;
  totalStock?: number;
};

type ApiProduct = {
  id: string;
  sku?: string;
  name: string;
  price_cents: number;
  currency?: string;
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
};

// Enriched fallback catalogue - looks like a real store
const fallbackProducts: Product[] = [
  {
    id: "867ba046-d776-5cb0-941d-56cb7d3a812f",
    name: "Transit Runner",
    price: 129,
    badge: "Limited 150",
    color: "sand",
    imageUrl: "/products/sneaker.jpg",
    description: "Suede & mesh upper. Cushioned EVA midsole. Unisex sizing.",
    rating: 4.8,
    reviewCount: 214,
    category: "Footwear",
    totalStock: 150,
    stock: 32,
  },
  {
    id: "5299be1f-2ea3-5d48-afb5-a728135d958e",
    name: "Pulse Mini",
    price: 79,
    badge: "New drop",
    color: "blue",
    imageUrl: "/products/speaker.jpg",
    description: "360° sound. IPX5 waterproof. 12-hour battery. Bluetooth 5.3.",
    rating: 4.6,
    reviewCount: 98,
    category: "Audio",
    totalStock: 200,
    stock: 61,
  },
  {
    id: "422f1457-f19d-5f3a-89a2-64f2fd21789f",
    name: "Weekender 02",
    price: 98,
    badge: "Last chance",
    color: "olive",
    imageUrl: "/products/bag.jpg",
    description: "Waxed canvas shell. Full-grain leather trim. 42L capacity.",
    rating: 4.9,
    reviewCount: 357,
    category: "Carry",
    totalStock: 80,
    stock: 9,
  },
];

const colors = ["sand", "blue", "olive"];

const enrichmentMap: Record<string, Partial<Product>> = {
  sneaker: fallbackProducts[0],
  speaker: fallbackProducts[1],
  bag: fallbackProducts[2],
  "TRANSIT-RUNNER": fallbackProducts[0],
  "PULSE-MINI": fallbackProducts[1],
  "WEEKENDER-02": fallbackProducts[2],
  "867ba046-d776-5cb0-941d-56cb7d3a812f": fallbackProducts[0],
  "5299be1f-2ea3-5d48-afb5-a728135d958e": fallbackProducts[1],
  "422f1457-f19d-5f3a-89a2-64f2fd21789f": fallbackProducts[2],
};

const formatPrice = (value: number) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(value);

function StarRating({ rating }: { rating: number }) {
  const full = Math.floor(rating);
  const half = rating - full >= 0.5;
  return (
    <span className="stars" aria-label={`${rating} out of 5`}>
      {Array.from({ length: 5 }, (_, i) => {
        if (i < full) return <span key={i} className="star filled">★</span>;
        if (i === full && half) return <span key={i} className="star half">★</span>;
        return <span key={i} className="star">★</span>;
      })}
    </span>
  );
}

function StockBar({ stock, total }: { stock: number; total: number }) {
  const pct = Math.max(0, Math.min(100, (stock / total) * 100));
  const lowStock = stock <= 15;
  return (
    <div className="stock-bar-wrap">
      <div className="stock-bar-track">
        <div
          className={`stock-bar-fill ${lowStock ? "low" : ""}`}
          style={{ width: `${pct}%` }}
        />
      </div>
      <span className={`stock-label ${lowStock ? "low" : ""}`}>
        {lowStock ? `Only ${stock} left!` : `${stock} in stock`}
      </span>
    </div>
  );
}

function AdminPanel({
  token,
  products,
  onNotify,
}: {
  token: string;
  products: Product[];
  onNotify: (msg: string, type?: "success" | "error") => void;
}) {
  const [summary, setSummary] = useState<{ products: number; orders: number; order_total_cents: number } | null>(null);
  const [isRestocking, setIsRestocking] = useState(false);

  const fetchDashboard = () => {
    fetch("/api/v1/admin/dashboard", { headers: { Authorization: `Bearer ${token}` } })
      .then((r) => (r.ok ? r.json() : null))
      .then(setSummary)
      .catch(() => setSummary(null));
  };

  useEffect(() => {
    fetchDashboard();
  }, [token]);

  const handleRestockAll = async () => {
    setIsRestocking(true);
    let successCount = 0;
    try {
      for (const prod of products) {
        const idempotencyKey = `restock-${prod.id}-${Date.now()}`;
        const res = await fetch(`/api/v1/admin/products/${prod.id}/restock`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({ quantity: 25, idempotency_key: idempotencyKey }),
        });
        if (res.ok) successCount++;
      }
      onNotify(`Successfully restocked +25 inventory to ${successCount} products!`, "success");
      fetchDashboard();
    } catch {
      onNotify("Failed to complete inventory restock.", "error");
    } finally {
      setIsRestocking(false);
    }
  };

  const [isCleaning, setIsCleaning] = useState(false);
  const handleCleanupExpired = async () => {
    setIsCleaning(true);
    try {
      const res = await fetch("/api/v1/admin/reservations/cleanup", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.ok) {
        const data = await res.json();
        onNotify(`Reclaimed ${data.released_count} expired reservation hold(s)!`, "success");
        fetchDashboard();
      } else {
        onNotify("Failed to release expired reservations.", "error");
      }
    } catch {
      onNotify("Network error while reclaiming holds.", "error");
    } finally {
      setIsCleaning(false);
    }
  };

  return (
    <section className="admin" id="admin">
      <div className="admin-header">
        <div>
          <p className="eyebrow">ADMINISTRATION</p>
          <h2>Store Overview &amp; Controls</h2>
        </div>
        <button className="admin-btn secondary" onClick={fetchDashboard} id="btn-refresh-admin">
          ↻ Refresh
        </button>
      </div>

      <div className="admin-stats">
        <div className="admin-stat-card">
          <b>{summary ? summary.products : products.length}</b>
          <span>Active Products</span>
        </div>
        <div className="admin-stat-card">
          <b>{summary ? summary.orders : 0}</b>
          <span>Completed Orders</span>
        </div>
        <div className="admin-stat-card">
          <b>{summary ? formatPrice(summary.order_total_cents / 100) : "$0.00"}</b>
          <span>Total Sales Volume</span>
        </div>
      </div>

      <div className="admin-actions">
        <button
          className="admin-btn"
          onClick={() => void handleRestockAll()}
          disabled={isRestocking}
          id="btn-restock-all"
        >
          {isRestocking ? "Restocking…" : "⚡ Restock All (+25)"}
        </button>
        <button
          className="admin-btn secondary"
          onClick={() => void handleCleanupExpired()}
          disabled={isCleaning}
          id="btn-clean-holds"
        >
          {isCleaning ? "Reclaiming…" : "♻ Purge Expired Holds"}
        </button>
        <span className="fine">Admin session active. Background worker purges expired reservations every 30s.</span>
      </div>
    </section>
  );
}

function App() {
  const [products, setProducts] = useState<Product[]>(fallbackProducts);
  const [cart, setCart] = useState<CartItem[]>([]);
  const [cartId, setCartId] = useState<string | null>(null);
  const [isCartOpen, setIsCartOpen] = useState(false);
  const [showAuthModal, setShowAuthModal] = useState(false);
  const [authTab, setAuthTab] = useState<"login" | "register">("login");
  const [showUserDropdown, setShowUserDropdown] = useState(false);
  const [completedOrder, setCompletedOrder] = useState<CompletedOrder | null>(null);

  // Form states
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [authError, setAuthError] = useState("");
  const [isAuthenticating, setIsAuthenticating] = useState(false);
  const [session, setSession] = useState<Session | null>(null);

  const [recentlyAddedId, setRecentlyAddedId] = useState<string | null>(null);
  const [isCheckingOut, setIsCheckingOut] = useState(false);

  // Countdown timer
  const [secondsRemaining, setSecondsRemaining] = useState(28795);

  // Toasts
  const [toasts, setToasts] = useState<Toast[]>([]);

  // Scroll header shadow
  const [isScrolled, setIsScrolled] = useState(false);

  const totalItemsCount = useMemo(() => cart.reduce((sum, item) => sum + item.quantity, 0), [cart]);
  const totalPrice = useMemo(() => cart.reduce((sum, item) => sum + item.product.price * item.quantity, 0), [cart]);

  useEffect(() => {
    const onScroll = () => setIsScrolled(window.scrollY > 20);
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  // Load products from API, merge with enrichment data
  useEffect(() => {
    fetch("/api/v1/products")
      .then((res) => (res.ok ? (res.json() as Promise<ApiProduct[]>) : Promise.reject()))
      .then((items) => {
        if (items.length) {
          setProducts(
            items.map((item, index) => {
              const enrich =
                enrichmentMap[item.id] ??
                (item.sku ? enrichmentMap[item.sku] : undefined) ??
                fallbackProducts[index % fallbackProducts.length] ??
                {};
              return {
                id: item.id,
                name: item.name,
                price: item.price_cents / 100,
                badge: index === 0 ? "Featured Drop" : "Available Now",
                color: colors[index % colors.length],
                imageUrl: enrich.imageUrl ?? `/products/${item.id}.jpg`,
                description: enrich.description ?? "Limited edition drop.",
                rating: enrich.rating ?? 4.5,
                reviewCount: enrich.reviewCount ?? 50,
                category: enrich.category ?? "Gear",
                totalStock: enrich.totalStock ?? 100,
                stock: enrich.stock ?? 25,
              };
            })
          );
        }
      })
      .catch(() => undefined);
  }, []);

  // Countdown synced with server clock
  useEffect(() => {
    fetch("/api/v1/system/time")
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (data?.server_time) {
          const serverMs = new Date(data.server_time).getTime();
          const targetMs = serverMs + 28800 * 1000;
          const diff = Math.max(0, Math.floor((targetMs - Date.now()) / 1000));
          setSecondsRemaining(diff);
        }
      })
      .catch(() => undefined);

    const timer = setInterval(() => {
      setSecondsRemaining((prev) => (prev > 0 ? prev - 1 : 28800));
    }, 1000);
    return () => clearInterval(timer);
  }, []);

  const formattedCountdown = useMemo(() => {
    const hrs = Math.floor(secondsRemaining / 3600);
    const mins = Math.floor((secondsRemaining % 3600) / 60);
    const secs = secondsRemaining % 60;
    return `${String(hrs).padStart(2, "0")}:${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
  }, [secondsRemaining]);

  const showToast = (
    message: string,
    type: "success" | "error" | "info" = "info",
    actionLabel?: string,
    onAction?: () => void
  ) => {
    const id = Math.random().toString(36).substring(2, 9);
    setToasts((prev) => [...prev, { id, message, type, actionLabel, onAction }]);
    setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, 4500);
  };

  const addToBag = async (product: Product) => {
    setCart((prev) => {
      const existing = prev.find((item) => item.product.id === product.id);
      if (existing) {
        return prev.map((item) =>
          item.product.id === product.id ? { ...item, quantity: item.quantity + 1 } : item
        );
      }
      return [...prev, { product, quantity: 1 }];
    });

    setRecentlyAddedId(product.id);
    setTimeout(() => setRecentlyAddedId(null), 1500);

    showToast(`${product.name} added to your bag`, "success", "View Bag", () => setIsCartOpen(true));

    try {
      let activeCart = cartId;
      if (!activeCart) {
        const res = await fetch("/api/v1/carts", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({}),
        });
        if (res.ok) {
          const created = await res.json();
          activeCart = created.id;
          setCartId(activeCart);
        }
      }
      if (activeCart) {
        await fetch(`/api/v1/carts/${activeCart}/items`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ product_id: product.id, quantity: 1 }),
        });
      }
    } catch {
      // Fallback works offline
    }
  };

  const updateQuantity = (productId: string, delta: number) => {
    setCart((prev) =>
      prev
        .map((item) => {
          if (item.product.id === productId) {
            const newQty = item.quantity + delta;
            return newQty > 0 ? { ...item, quantity: newQty } : null;
          }
          return item;
        })
        .filter(Boolean) as CartItem[]
    );
  };

  const removeItem = (productId: string) => {
    setCart((prev) => prev.filter((item) => item.product.id !== productId));
    showToast("Item removed from bag");
  };

  const handleCheckout = async () => {
    if (!cart.length) {
      showToast("Your bag is empty. Add a product first!", "info");
      return;
    }

    setIsCheckingOut(true);
    try {
      let activeCart = cartId;

      if (!activeCart) {
        const createdRes = await fetch("/api/v1/carts", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({}),
        });
        if (!createdRes.ok) throw new Error("Could not initialize checkout bag.");
        const created = await createdRes.json();
        activeCart = created.id;
        setCartId(activeCart);

        for (const item of cart) {
          const itemRes = await fetch(`/api/v1/carts/${activeCart}/items`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ product_id: item.product.id, quantity: item.quantity }),
          });
          if (!itemRes.ok) {
            const errData = await itemRes.json().catch(() => ({}));
            throw new Error(errData.detail || `Could not reserve ${item.product.name} in bag.`);
          }
        }
      }

      const idempotencyKey =
        typeof crypto !== "undefined" && crypto.randomUUID
          ? crypto.randomUUID()
          : `chk-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;

      const orderRes = await fetch(`/api/v1/orders/checkout/${activeCart}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": idempotencyKey,
        },
      });
      if (!orderRes.ok) {
        if (orderRes.status === 429) {
          throw new Error("High checkout volume! You're in line — please wait a few seconds and try again.");
        }
        const errData = await orderRes.json().catch(() => ({}));
        throw new Error(errData.detail || "Checkout reservation could not be completed.");
      }
      const order = await orderRes.json();

      const payRes = await fetch(`/api/v1/orders/${order.id}/pay`, { method: "POST" });
      if (!payRes.ok) {
        const errData = await payRes.json().catch(() => ({}));
        throw new Error(errData.detail || "Payment authorization failed.");
      }
      const paid = await payRes.json();

      setCompletedOrder({
        orderNumber: paid.order_number,
        totalCents: paid.total_cents,
        currency: paid.currency,
        items: [...cart],
      });

      setCart([]);
      setCartId(null);
      setIsCartOpen(false);
      showToast(`Order ${paid.order_number} confirmed!`, "success");
    } catch (err: any) {
      const isNetworkErr =
        err?.name === "TypeError" &&
        (err?.message?.includes("fetch") || err?.message?.includes("Network") || err?.message?.includes("Failed"));
      showToast(
        isNetworkErr
          ? "Unable to reach checkout server. Please make sure the backend API is running."
          : err.message || "Checkout failed. Product inventory may be sold out.",
        "error"
      );
    } finally {
      setIsCheckingOut(false);
    }
  };

  const handleAuth = async (event: FormEvent) => {
    event.preventDefault();
    setAuthError("");
    setIsAuthenticating(true);

    try {
      if (authTab === "login") {
        const res = await fetch("/api/v1/auth/login", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email, password }),
        });
        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          throw new Error(err.detail || "Incorrect email or password.");
        }
        const data = await res.json();
        setSession({
          token: data.access_token,
          role: data.user.role,
          displayName: data.user.display_name,
          email: data.user.email,
        });
        setShowAuthModal(false);
        showToast(`Welcome back, ${data.user.display_name}!`, "success");
      } else {
        const res = await fetch("/api/v1/auth/register", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email, password, display_name: displayName }),
        });
        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          throw new Error(err.detail || "Could not register account. Email may be taken.");
        }
        const data = await res.json();
        setSession({
          token: data.access_token,
          role: data.user.role,
          displayName: data.user.display_name,
          email: data.user.email,
        });
        setShowAuthModal(false);
        showToast(`Account created! Welcome to SurgeCart, ${data.user.display_name}.`, "success");
      }
    } catch (err: any) {
      setAuthError(err.message || "Authentication error.");
    } finally {
      setIsAuthenticating(false);
    }
  };

  const handleAdminQuickFill = () => {
    setEmail("admin@surgecart.local");
    setPassword("change-this-password");
    setAuthTab("login");
  };

  const scrollToSection = (id: string) => {
    const element = document.getElementById(id);
    if (element) {
      element.scrollIntoView({ behavior: "smooth" });
    }
  };

  return (
    <>
      {/* ── Navigation ── */}
      <header className={`header-wrapper${isScrolled ? " header-scrolled" : ""}`}>
        <div className="nav">
          <a
            className="brand"
            href="#top"
            onClick={(e) => {
              e.preventDefault();
              window.scrollTo({ top: 0, behavior: "smooth" });
            }}
            id="brand-logo"
          >
            surge<span>cart</span>
          </a>

          <div className="nav-actions">
            <nav aria-label="Primary">
              <a
                href="#drops"
                onClick={(e) => { e.preventDefault(); scrollToSection("drops"); }}
                id="nav-link-drops"
              >
                New Drops
              </a>
              <a
                href="#how"
                onClick={(e) => { e.preventDefault(); scrollToSection("how"); }}
                id="nav-link-how"
              >
                How It Works
              </a>
              {session?.role === "admin" && (
                <a
                  href="#admin"
                  className="admin-nav-badge"
                  onClick={(e) => { e.preventDefault(); scrollToSection("admin"); }}
                  id="nav-link-admin"
                >
                  Admin
                </a>
              )}
            </nav>

            <div className="user-menu-container">
              {session ? (
                <>
                  <button
                    className="auth-button user-logged-pill"
                    onClick={() => setShowUserDropdown((prev) => !prev)}
                    id="user-profile-button"
                  >
                    <span className="user-avatar-initial">{session.displayName.charAt(0).toUpperCase()}</span>
                    <span>{session.displayName}</span>
                    <span style={{ fontSize: "10px" }}>▼</span>
                  </button>

                  {showUserDropdown && (
                    <div className="user-dropdown">
                      <div className="user-dropdown-header">
                        <div className="user-dropdown-name">{session.displayName}</div>
                        <div className="user-dropdown-role">{session.role} account</div>
                      </div>
                      {session.role === "admin" && (
                        <button
                          className="user-dropdown-item"
                          onClick={() => { setShowUserDropdown(false); scrollToSection("admin"); }}
                          id="btn-goto-admin"
                        >
                          ⚡ Admin Dashboard
                        </button>
                      )}
                      <button
                        className="user-dropdown-item logout"
                        onClick={() => {
                          setSession(null);
                          setShowUserDropdown(false);
                          showToast("Signed out successfully.");
                        }}
                        id="btn-sign-out"
                      >
                        Sign Out
                      </button>
                    </div>
                  )}
                </>
              ) : (
                <button
                  className="auth-button"
                  onClick={() => { setAuthError(""); setShowAuthModal(true); }}
                  id="btn-open-login"
                >
                  Sign In
                </button>
              )}
            </div>

            <button className="bag" onClick={() => setIsCartOpen(true)} id="btn-toggle-bag">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M6 2L3 6v14a2 2 0 002 2h14a2 2 0 002-2V6l-3-4z"/><line x1="3" y1="6" x2="21" y2="6"/><path d="M16 10a4 4 0 01-8 0"/></svg>
              {totalItemsCount > 0 && <b>{totalItemsCount}</b>}
            </button>
          </div>
        </div>
      </header>

      {/* ── Main Content ── */}
      <main id="top">

        {/* ── Hero ── */}
        <section className="hero">
          <div className="hero-text">
            <p className="eyebrow">TODAY'S FEATURED DROP</p>
            <h1>
              Limited goods.<br />
              <em>Fair access.</em>
            </h1>
            <p className="hero-copy">
              Curated products released in small batches. Every checkout is protected with row-level stock locks — first to confirm, first to own.
            </p>
            <div className="hero-actions">
              <button
                className="button"
                onClick={() => scrollToSection("drops")}
                id="btn-shop-drop-hero"
              >
                Shop the Drop <span>→</span>
              </button>
              <button
                className="button-ghost"
                onClick={() => scrollToSection("how")}
                id="btn-how-hero"
              >
                How it works
              </button>
            </div>
            <div className="trust-row">
              <span className="trust-item">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"><path d="M5 12h14M12 5l7 7-7 7"/></svg>
                Free shipping over $75
              </span>
              <span className="trust-item">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>
                Secure checkout
              </span>
              <span className="trust-item">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"><path d="M21 10c0 7-9 13-9 13S3 17 3 10a9 9 0 0118 0z"/><circle cx="12" cy="10" r="3"/></svg>
                Ships worldwide
              </span>
            </div>
          </div>

          {/* Countdown card */}
          <div
            className="hero-card"
            onClick={() => scrollToSection("drops")}
            title="Click to view today's active drops"
            id="hero-drop-card"
          >
            <div className="hero-card-header">
              <span className="hero-card-tag">DROP 07</span>
              <span className="hero-card-pulse" />
            </div>
            <div className="hero-card-body">
              <p className="hero-card-label">Sale ends in</p>
              <strong>{formattedCountdown}</strong>
              <div className="hero-card-caption">
                <span>Limited stock — act fast</span>
                <span className="hero-card-link">Browse →</span>
              </div>
            </div>
            <div className="orb" />
          </div>
        </section>

        {/* ── Products ── */}
        <section id="drops" className="products">
          <div className="section-heading">
            <div>
              <p className="eyebrow">NEW DROPS</p>
              <h2>This week's releases.</h2>
            </div>
            <p>Every item ships in limited quantities. Once the allocation is gone, it's gone for good.</p>
          </div>

          <div className="grid">
            {products.map((product) => {
              const isAdded = recentlyAddedId === product.id;
              const stock = product.stock ?? 25;
              const total = product.totalStock ?? 100;
              return (
                <article key={product.id} className="product" id={`product-card-${product.id}`}>
                  {/* Product image */}
                  <div className="product-image-wrap">
                    {product.imageUrl ? (
                      <img
                        src={product.imageUrl}
                        alt={product.name}
                        className="product-img"
                        loading="lazy"
                      />
                    ) : (
                      <div className={`product-image-fallback ${product.color}`}>
                        <div className="shape" />
                      </div>
                    )}
                    <span className="product-badge">{product.badge}</span>
                    {product.category && (
                      <span className="product-category">{product.category}</span>
                    )}
                  </div>

                  {/* Product info */}
                  <div className="product-body">
                    <div className="product-meta">
                      {product.rating !== undefined && (
                        <div className="product-rating">
                          <StarRating rating={product.rating} />
                          <span className="review-count">({product.reviewCount})</span>
                        </div>
                      )}
                      <h3 className="product-name">{product.name}</h3>
                      {product.description && (
                        <p className="product-desc">{product.description}</p>
                      )}
                    </div>

                    <div className="product-footer">
                      <StockBar stock={stock} total={total} />
                      <div className="product-price-row">
                        <span className="product-price">{formatPrice(product.price)}</span>
                        <button
                          className={`product-add-btn ${isAdded ? "added" : ""}`}
                          onClick={() => void addToBag(product)}
                          id={`btn-add-${product.id}`}
                        >
                          {isAdded ? "Added ✓" : "Add to Bag"}
                        </button>
                      </div>
                    </div>
                  </div>
                </article>
              );
            })}
          </div>
        </section>

        {/* ── How It Works ── */}
        <section id="how" className="steps">
          <div className="steps-inner">
            <div className="steps-header">
              <p className="eyebrow" style={{ color: "#9dc9a8" }}>HOW IT WORKS</p>
              <h2>Fair drops for<br /><em>real people.</em></h2>
              <p className="steps-sub">We built SurgeCart so bots can't win. Every checkout is fair, transparent, and fast.</p>
            </div>
            <div className="step-grid">
              <div className="step-card">
                <div className="step-icon">
                  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
                </div>
                <h4>Browse openly</h4>
                <p>Stock levels are visible before you buy. No hidden queues, no false scarcity messaging.</p>
              </div>
              <div className="step-card">
                <div className="step-icon">
                  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0110 0v4"/></svg>
                </div>
                <h4>Your item is held</h4>
                <p>When you check out, your stock is locked with a database-level row lock for 10 minutes while you pay.</p>
              </div>
              <div className="step-card">
                <div className="step-icon">
                  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
                </div>
                <h4>Instant confirmation</h4>
                <p>Payment confirms and commits inventory atomically. You get an order number immediately.</p>
              </div>
            </div>
          </div>
        </section>

        {/* ── Checkout Banner ── */}
        <section className="checkout-banner" id="checkout-summary">
          <div>
            <p className="eyebrow">YOUR BAG</p>
            <h2>
              {totalItemsCount > 0
                ? `${totalItemsCount} item${totalItemsCount > 1 ? "s" : ""} · ${formatPrice(totalPrice)}`
                : "Your bag is empty."}
            </h2>
            <p className="fine" style={{ margin: "4px 0 0" }}>
              {totalItemsCount > 0
                ? "Ready to reserve. Complete checkout to lock your stock."
                : "Explore this week's drops above."}
            </p>
          </div>

          <div className="checkout-banner-actions">
            {totalItemsCount > 0 && (
              <button
                className="button-outline"
                onClick={() => setIsCartOpen(true)}
                id="btn-view-bag-bottom"
              >
                View Bag ({totalItemsCount})
              </button>
            )}
            <button
              className="button"
              onClick={() => void handleCheckout()}
              disabled={isCheckingOut || totalItemsCount === 0}
              id="btn-checkout-bottom"
            >
              {isCheckingOut ? "Reserving…" : "Checkout"} <span>→</span>
            </button>
          </div>
        </section>

        {/* ── Admin Panel ── */}
        {session?.role === "admin" && (
          <AdminPanel token={session.token} products={products} onNotify={showToast} />
        )}
      </main>

      {/* ── Footer ── */}
      <footer>
        <div className="footer-brand-col">
          <a
            className="brand"
            href="#top"
            onClick={(e) => { e.preventDefault(); window.scrollTo({ top: 0, behavior: "smooth" }); }}
            id="footer-brand"
          >
            surge<span>cart</span>
          </a>
          <p className="footer-tagline">Limited drops, fairly sold.</p>
        </div>

        <div className="footer-links">
          <div className="footer-link-group">
            <strong>Shop</strong>
            <a href="#drops" onClick={(e) => { e.preventDefault(); scrollToSection("drops"); }}>New Drops</a>
            <a href="#how" onClick={(e) => { e.preventDefault(); scrollToSection("how"); }}>How It Works</a>
          </div>
          <div className="footer-link-group">
            <strong>Support</strong>
            <a href="mailto:hello@surgecart.local" id="footer-contact">Contact Us</a>
            <a href="#faq">Returns &amp; Exchanges</a>
            <a href="#faq">Shipping Info</a>
          </div>
        </div>

        <div className="footer-bottom">
          <span>© 2025 SurgeCart. All rights reserved.</span>
          <span>
            <a href="#privacy">Privacy Policy</a> · <a href="#terms">Terms of Use</a>
          </span>
        </div>
      </footer>

      {/* ── Cart Drawer ── */}
      {isCartOpen && (
        <div
          className="drawer-backdrop"
          onClick={() => setIsCartOpen(false)}
          role="presentation"
        >
          <div
            className="cart-drawer"
            onClick={(e) => e.stopPropagation()}
            id="cart-drawer"
          >
            <div className="drawer-header">
              <h2>
                Your Bag {totalItemsCount > 0 && <span>({totalItemsCount})</span>}
              </h2>
              <button
                className="close-btn"
                onClick={() => setIsCartOpen(false)}
                aria-label="Close cart drawer"
                id="btn-close-drawer"
              >
                ✕
              </button>
            </div>

            {cart.length === 0 ? (
              <div className="drawer-empty">
                <div className="drawer-empty-icon">
                  <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M6 2L3 6v14a2 2 0 002 2h14a2 2 0 002-2V6l-3-4z"/><line x1="3" y1="6" x2="21" y2="6"/><path d="M16 10a4 4 0 01-8 0"/></svg>
                </div>
                <h3>Your bag is empty</h3>
                <p>Explore this week's limited drops and add something before it sells out.</p>
                <button
                  className="button"
                  onClick={() => { setIsCartOpen(false); scrollToSection("drops"); }}
                  id="btn-drawer-explore"
                >
                  Explore Drops <span>→</span>
                </button>
              </div>
            ) : (
              <>
                <div className="drawer-items">
                  {cart.map((item) => (
                    <div className="cart-item" key={item.product.id}>
                      <div className="cart-item-thumb">
                        {item.product.imageUrl ? (
                          <img src={item.product.imageUrl} alt={item.product.name} />
                        ) : (
                          <div className={`cart-item-thumb-fallback ${item.product.color}`} />
                        )}
                      </div>
                      <div className="cart-item-details">
                        <div className="cart-item-title">{item.product.name}</div>
                        <div className="cart-item-price">{formatPrice(item.product.price)}</div>
                      </div>
                      <div className="cart-qty-controls">
                        <button
                          className="cart-qty-btn"
                          onClick={() => updateQuantity(item.product.id, -1)}
                          aria-label="Decrease quantity"
                          id={`btn-qty-minus-${item.product.id}`}
                        >−</button>
                        <span className="cart-qty-val">{item.quantity}</span>
                        <button
                          className="cart-qty-btn"
                          onClick={() => updateQuantity(item.product.id, 1)}
                          aria-label="Increase quantity"
                          id={`btn-qty-plus-${item.product.id}`}
                        >+</button>
                      </div>
                      <button
                        className="cart-item-remove"
                        onClick={() => removeItem(item.product.id)}
                        aria-label="Remove item"
                        title="Remove"
                        id={`btn-remove-${item.product.id}`}
                      >✕</button>
                    </div>
                  ))}
                </div>

                <div className="drawer-footer">
                  <div className="drawer-hold-card" id="drawer-hold-card">
                    <div className="drawer-hold-badge">
                      <span className="drawer-hold-pulse" aria-hidden="true" />
                      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                        <rect x="3" y="11" width="18" height="11" rx="2" ry="2"/>
                        <path d="M7 11V7a5 5 0 0 1 10 0v4"/>
                      </svg>
                    </div>
                    <div className="drawer-hold-text">
                      <div className="drawer-hold-title">Stock held for 10 minutes</div>
                      <div className="drawer-hold-subtitle">Your allocation is reserved during checkout</div>
                    </div>
                  </div>
                  <div className="drawer-summary-row">
                    <span>Subtotal</span>
                    <span>{formatPrice(totalPrice)}</span>
                  </div>
                  <div className="drawer-summary-row">
                    <span>Shipping</span>
                    <span style={{ color: "var(--color-terracotta)", fontWeight: 600 }}>Free</span>
                  </div>
                  <div className="drawer-summary-row total">
                    <span>Estimated Total</span>
                    <span>{formatPrice(totalPrice)}</span>
                  </div>
                  <button
                    className="button drawer-checkout-btn"
                    onClick={() => void handleCheckout()}
                    disabled={isCheckingOut}
                    id="btn-drawer-checkout"
                  >
                    {isCheckingOut ? "Reserving & Authorizing…" : "Complete Checkout"} <span>→</span>
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {/* ── Auth Modal ── */}
      {showAuthModal && (
        <div
          className="dialog-backdrop"
          onClick={() => setShowAuthModal(false)}
          role="presentation"
        >
          <form
            className="dialog"
            onSubmit={(e) => void handleAuth(e)}
            onClick={(e) => e.stopPropagation()}
            id="auth-form"
          >
            <button
              type="button"
              className="close-btn"
              onClick={() => setShowAuthModal(false)}
              aria-label="Close dialog"
              id="btn-close-auth"
            >✕</button>

            <p className="eyebrow">{authTab === "login" ? "WELCOME BACK" : "JOIN SURGECART"}</p>
            <h2>{authTab === "login" ? "Sign In" : "Create Account"}</h2>

            <div className="dialog-tabs">
              <button
                type="button"
                className={`dialog-tab ${authTab === "login" ? "active" : ""}`}
                onClick={() => { setAuthTab("login"); setAuthError(""); }}
                id="tab-auth-login"
              >Log In</button>
              <button
                type="button"
                className={`dialog-tab ${authTab === "register" ? "active" : ""}`}
                onClick={() => { setAuthTab("register"); setAuthError(""); }}
                id="tab-auth-register"
              >Create Account</button>
            </div>

            {authError && <div className="dialog-error">{authError}</div>}

            {authTab === "register" && (
              <label>
                Full Name
                <input
                  required
                  type="text"
                  value={displayName}
                  onChange={(e) => setDisplayName(e.target.value)}
                  placeholder="Alex Morgan"
                  id="input-auth-name"
                />
              </label>
            )}

            <label>
              Email Address
              <input
                required
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@example.com"
                id="input-auth-email"
              />
            </label>

            <label>
              Password
              <input
                required
                type="password"
                minLength={8}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="At least 8 characters"
                id="input-auth-password"
              />
            </label>

            <button
              className="button"
              type="submit"
              disabled={isAuthenticating}
              id="btn-auth-submit"
            >
              {isAuthenticating
                ? "Processing…"
                : authTab === "login"
                ? "Sign In"
                : "Create Account"}{" "}
              <span>→</span>
            </button>

            {authTab === "login" && (
              <div className="demo-account-hint">
                <div>
                  <strong>Admin demo:</strong>
                  <div style={{ color: "var(--color-text-muted)", marginTop: 2 }}>admin@surgecart.local</div>
                </div>
                <button type="button" onClick={handleAdminQuickFill} id="btn-quick-fill-admin">
                  ⚡ Quick Fill
                </button>
              </div>
            )}
          </form>
        </div>
      )}

      {/* ── Order Confirmation Modal ── */}
      {completedOrder && (
        <div
          className="dialog-backdrop"
          onClick={() => setCompletedOrder(null)}
          role="presentation"
        >
          <div
            className="dialog order-success-card"
            onClick={(e) => e.stopPropagation()}
            id="order-success-modal"
          >
            <div className="order-success-icon">✓</div>
            <p className="eyebrow">ORDER CONFIRMED</p>
            <h2>Thank you!</h2>
            <p className="hero-copy" style={{ margin: "8px auto 16px", fontSize: 15 }}>
              Your allocation has been locked and confirmed. A confirmation email is on its way.
            </p>

            <div className="order-success-number">{completedOrder.orderNumber}</div>

            <div className="order-success-details">
              <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "8px" }}>
                <span>Total Paid:</span>
                <b>{formatPrice(completedOrder.totalCents / 100)}</b>
              </div>
              <div style={{ display: "flex", justifyContent: "space-between" }}>
                <span>Payment:</span>
                <span style={{ color: "var(--color-terracotta)", fontWeight: 600 }}>Demo Verified</span>
              </div>
            </div>

            <button
              className="button"
              style={{ width: "100%" }}
              onClick={() => setCompletedOrder(null)}
              id="btn-order-continue-shopping"
            >
              Continue Shopping <span>→</span>
            </button>
          </div>
        </div>
      )}

      {/* ── Toast Notifications ── */}
      <div className="toast-container" aria-live="polite">
        {toasts.map((toast) => (
          <div className={`toast toast-${toast.type ?? "info"}`} key={toast.id}>
            <div className="toast-content">
              <span>{toast.type === "error" ? "⚠" : toast.type === "success" ? "✓" : "ℹ"}</span>
              <span>{toast.message}</span>
            </div>
            {toast.actionLabel && toast.onAction && (
              <button
                className="toast-action"
                onClick={() => {
                  toast.onAction?.();
                  setToasts((prev) => prev.filter((t) => t.id !== toast.id));
                }}
              >
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
