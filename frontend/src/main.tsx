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
};

type ApiProduct = {
  id: string;
  name: string;
  price_cents: number;
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

const fallbackProducts: Product[] = [
  { id: "sneaker", name: "Transit Runner", price: 129, badge: "Limited 150", color: "sand" },
  { id: "speaker", name: "Pulse Mini", price: 79, badge: "New drop", color: "blue" },
  { id: "bag", name: "Weekender 02", price: 98, badge: "Last chance", color: "orange" },
];

const colors = ["sand", "blue", "orange"];

const formatPrice = (value: number) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(value);

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
          <h2>Store Overview & Controls</h2>
        </div>
        <button className="admin-btn secondary" onClick={fetchDashboard} id="btn-refresh-admin">
          ↻ Refresh Data
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
          {isRestocking ? "Restocking..." : "⚡ Restock All Products (+25)"}
        </button>
        <button
          className="admin-btn secondary"
          onClick={() => void handleCleanupExpired()}
          disabled={isCleaning}
          id="btn-clean-holds"
        >
          {isCleaning ? "Reclaiming..." : "♻ Purge Expired Holds"}
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

  // Button micro-state feedback (e.g. Added!)
  const [recentlyAddedId, setRecentlyAddedId] = useState<string | null>(null);
  const [isCheckingOut, setIsCheckingOut] = useState(false);

  // Countdown timer for drop
  const [secondsRemaining, setSecondsRemaining] = useState(28795); // ~8 hours

  // Toasts
  const [toasts, setToasts] = useState<Toast[]>([]);

  const totalItemsCount = useMemo(() => cart.reduce((sum, item) => sum + item.quantity, 0), [cart]);
  const totalPrice = useMemo(() => cart.reduce((sum, item) => sum + item.product.price * item.quantity, 0), [cart]);

  // Load products from API
  useEffect(() => {
    fetch("/api/v1/products")
      .then((res) => (res.ok ? (res.json() as Promise<ApiProduct[]>) : Promise.reject()))
      .then((items) => {
        if (items.length) {
          setProducts(
            items.map((item, index) => ({
              id: item.id,
              name: item.name,
              price: item.price_cents / 100,
              badge: index === 0 ? "Featured Drop" : "Available Now",
              color: colors[index % colors.length],
            }))
          );
        }
      })
      .catch(() => undefined);
  }, []);

  // Ticking countdown timer synced with server clock
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

  // Add product to cart
  const addToBag = async (product: Product) => {
    // Optimistically update local cart
    setCart((prev) => {
      const existing = prev.find((item) => item.product.id === product.id);
      if (existing) {
        return prev.map((item) =>
          item.product.id === product.id ? { ...item, quantity: item.quantity + 1 } : item
        );
      }
      return [...prev, { product, quantity: 1 }];
    });

    // Provide immediate visual feedback on the button
    setRecentlyAddedId(product.id);
    setTimeout(() => setRecentlyAddedId(null), 1200);

    // Toast notification with "View Bag" action
    showToast(`${product.name} added to your bag`, "success", "View Bag", () => setIsCartOpen(true));

    // Sync with backend API
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
      // Fallback works seamlessly offline
    }
  };

  // Update item quantity
  const updateQuantity = (productId: string, delta: number) => {
    setCart((prev) => {
      return prev
        .map((item) => {
          if (item.product.id === productId) {
            const newQty = item.quantity + delta;
            return newQty > 0 ? { ...item, quantity: newQty } : null;
          }
          return item;
        })
        .filter(Boolean) as CartItem[];
    });
  };

  // Remove item completely
  const removeItem = (productId: string) => {
    setCart((prev) => prev.filter((item) => item.product.id !== productId));
    showToast("Item removed from bag");
  };

  // Checkout process
  const handleCheckout = async () => {
    if (!cart.length) {
      showToast("Your bag is empty. Add a product first!", "info");
      return;
    }

    setIsCheckingOut(true);
    try {
      let activeCart = cartId;

      // Ensure active cart exists on server with current items
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
          await fetch(`/api/v1/carts/${activeCart}/items`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ product_id: item.product.id, quantity: item.quantity }),
          });
        }
      }

      // Client idempotency key to prevent double checkout on connection drops or double clicks
      const idempotencyKey =
        typeof crypto !== "undefined" && crypto.randomUUID
          ? crypto.randomUUID()
          : `chk-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;

      // Step 1: Checkout & reserve stock
      const orderRes = await fetch(`/api/v1/orders/checkout/${activeCart}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": idempotencyKey,
        },
      });
      if (!orderRes.ok) {
        if (orderRes.status === 429) {
          throw new Error("High checkout volume! You are in line—please wait a few seconds and try again.");
        }
        const errData = await orderRes.json().catch(() => ({}));
        throw new Error(errData.detail || "Checkout reservation could not be completed.");
      }
      const order = await orderRes.json();

      // Step 2: Confirm demo payment
      const payRes = await fetch(`/api/v1/orders/${order.id}/pay`, { method: "POST" });
      if (!payRes.ok) {
        const errData = await payRes.json().catch(() => ({}));
        throw new Error(errData.detail || "Payment authorization failed.");
      }
      const paid = await payRes.json();

      // Complete order
      setCompletedOrder({
        orderNumber: paid.order_number,
        totalCents: paid.total_cents,
        currency: paid.currency,
        items: [...cart],
      });

      // Reset state for new purchases
      setCart([]);
      setCartId(null);
      setIsCartOpen(false);
      showToast(`Order ${paid.order_number} confirmed!`, "success");
    } catch (err: any) {
      showToast(err.message || "Checkout failed. Product inventory may be sold out.", "error");
    } finally {
      setIsCheckingOut(false);
    }
  };

  // Auth: Sign in / Register
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

  // Demo Admin quick login
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
      {/* Sticky Navigation Header */}
      <header className="header-wrapper">
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
                onClick={(e) => {
                  e.preventDefault();
                  scrollToSection("drops");
                }}
                id="nav-link-drops"
              >
                Drops
              </a>
              <a
                href="#how"
                onClick={(e) => {
                  e.preventDefault();
                  scrollToSection("how");
                }}
                id="nav-link-how"
              >
                How it works
              </a>
              {session?.role === "admin" && (
                <a
                  href="#admin"
                  className="admin-nav-badge"
                  onClick={(e) => {
                    e.preventDefault();
                    scrollToSection("admin");
                  }}
                  id="nav-link-admin"
                >
                  Admin Portal
                </a>
              )}
            </nav>

            {/* User Session / Login Button */}
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
                          onClick={() => {
                            setShowUserDropdown(false);
                            scrollToSection("admin");
                          }}
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
                  onClick={() => {
                    setAuthError("");
                    setShowAuthModal(true);
                  }}
                  id="btn-open-login"
                >
                  Log in
                </button>
              )}
            </div>

            {/* Bag Button - Toggles Drawer */}
            <button className="bag" onClick={() => setIsCartOpen(true)} id="btn-toggle-bag">
              Bag <b>{totalItemsCount}</b>
            </button>
          </div>
        </div>
      </header>

      {/* Main Content */}
      <main id="top">
        {/* Hero Section */}
        <section className="hero">
          <div>
            <p className="eyebrow">TODAY'S FEATURED DROP</p>
            <h1>
              Get there
              <br />
              <em>first.</em>
            </h1>
            <p className="hero-copy">
              Thoughtful goods. Limited runs. A checkout designed to be fair when demand is high.
            </p>
            <button
              className="button"
              onClick={() => scrollToSection("drops")}
              id="btn-shop-drop-hero"
            >
              Shop the drop <span>→</span>
            </button>
          </div>

          {/* Interactive Drop Countdown Card */}
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
              <strong>{formattedCountdown}</strong>
              <div className="hero-card-caption">
                <span>time remaining in drop</span>
                <span className="hero-card-link">Browse collection →</span>
              </div>
            </div>
            <div className="orb" />
          </div>
        </section>

        {/* Drops / Products Section */}
        <section id="drops" className="products">
          <div className="section-heading">
            <div>
              <p className="eyebrow">SHOP NOW</p>
              <h2>Made for the moment.</h2>
            </div>
            <p>Every item is released in limited allocations. Once reserved and sold out, it’s gone.</p>
          </div>

          <div className="grid">
            {products.map((product) => {
              const isAdded = recentlyAddedId === product.id;
              return (
                <article key={product.id} className="product" id={`product-card-${product.id}`}>
                  <div className={`product-image ${product.color}`}>
                    <span>{product.badge}</span>
                    <span className="product-stock-pill">In Stock</span>
                    <div className="shape" />
                  </div>
                  <div className="product-info">
                    <div>
                      <h3>{product.name}</h3>
                      <p>SurgeCart studio edition</p>
                    </div>
                    <div className="product-price">{formatPrice(product.price)}</div>
                  </div>
                  <button
                    className={`product-add-btn ${isAdded ? "added" : ""}`}
                    onClick={() => void addToBag(product)}
                    id={`btn-add-${product.id}`}
                  >
                    {isAdded ? "Added to Bag ✓" : "Add to bag"}
                    <span>{isAdded ? "✓" : "+"}</span>
                  </button>
                </article>
              );
            })}
          </div>
        </section>

        {/* How It Works Section */}
        <section id="how" className="steps">
          <p className="eyebrow">A FAIRER DROP</p>
          <h2>
            Quick, clear, and
            <br />
            built for everyone.
          </h2>
          <div className="step-grid">
            <div className="step-card">
              <p>
                <b>01</b>
                Limited inventory is shown clearly before you buy, preventing false hope and hidden queues.
              </p>
            </div>
            <div className="step-card">
              <p>
                <b>02</b>
                Your item is securely held with database row-level locks for 10 minutes while you complete checkout.
              </p>
            </div>
            <div className="step-card">
              <p>
                <b>03</b>
                Demo payment adapter instantly confirms the order and commits inventory. Fast and safe.
              </p>
            </div>
          </div>
        </section>

        {/* Bag / Checkout Section */}
        <section className="checkout-banner" id="checkout-summary">
          <div>
            <p className="eyebrow">YOUR CURRENT SELECTION</p>
            <h2>
              {totalItemsCount > 0
                ? `${totalItemsCount} item${totalItemsCount > 1 ? "s" : ""} · ${formatPrice(totalPrice)}`
                : "Your bag is waiting."}
            </h2>
            <p className="fine" style={{ margin: "4px 0 0" }}>
              {totalItemsCount > 0
                ? "Items are ready for reservation. Click checkout to lock stock."
                : "Select any drop above to begin."}
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
              {isCheckingOut ? "Reserving..." : "Checkout now"} <span>→</span>
            </button>
          </div>
        </section>

        {/* Admin Dashboard if logged in as admin */}
        {session?.role === "admin" && (
          <AdminPanel token={session.token} products={products} onNotify={showToast} />
        )}
      </main>

      {/* Footer */}
      <footer>
        <a
          className="brand"
          href="#top"
          onClick={(e) => {
            e.preventDefault();
            window.scrollTo({ top: 0, behavior: "smooth" });
          }}
          id="footer-brand"
        >
          surge<span>cart</span>
        </a>
        <p>Limited drops, fairly sold. High-concurrency flash sale platform.</p>
        <a href="mailto:hello@surgecart.local" id="footer-contact">
          hello@surgecart.local
        </a>
      </footer>

      {/* Cart Drawer (Slide-out panel) */}
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
                Your Bag <span>({totalItemsCount})</span>
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
                <div className="drawer-empty-icon">🛍️</div>
                <h3>Your bag is empty</h3>
                <p>Explore today's limited drops and grab your item before allocations run out.</p>
                <button
                  className="button"
                  onClick={() => {
                    setIsCartOpen(false);
                    scrollToSection("drops");
                  }}
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
                      <div className={`cart-item-thumb ${item.product.color}`}>
                        <span style={{ fontSize: "18px" }}>📦</span>
                      </div>
                      <div className="cart-item-details">
                        <div className="cart-item-title">{item.product.name}</div>
                        <div className="cart-item-price">{formatPrice(item.product.price)} each</div>
                      </div>
                      <div className="cart-qty-controls">
                        <button
                          className="cart-qty-btn"
                          onClick={() => updateQuantity(item.product.id, -1)}
                          aria-label="Decrease quantity"
                          id={`btn-qty-minus-${item.product.id}`}
                        >
                          −
                        </button>
                        <span className="cart-qty-val">{item.quantity}</span>
                        <button
                          className="cart-qty-btn"
                          onClick={() => updateQuantity(item.product.id, 1)}
                          aria-label="Increase quantity"
                          id={`btn-qty-plus-${item.product.id}`}
                        >
                          +
                        </button>
                      </div>
                      <button
                        className="cart-item-remove"
                        onClick={() => removeItem(item.product.id)}
                        aria-label="Remove item"
                        title="Remove"
                        id={`btn-remove-${item.product.id}`}
                      >
                        ✕
                      </button>
                    </div>
                  ))}
                </div>

                <div className="drawer-footer">
                  <div className="drawer-hold-pill">
                    <span>⚡</span> Items are held with row-level locks for 10 min during checkout.
                  </div>
                  <div className="drawer-summary-row">
                    <span>Subtotal</span>
                    <span>{formatPrice(totalPrice)}</span>
                  </div>
                  <div className="drawer-summary-row">
                    <span>Flash Drop Shipping</span>
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
                    {isCheckingOut ? "Reserving & Authorizing..." : "Complete Checkout"} <span>→</span>
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {/* Authentication Modal (Login & Registration) */}
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
            >
              ✕
            </button>

            <p className="eyebrow">{authTab === "login" ? "WELCOME BACK" : "JOIN SURGECART"}</p>
            <h2>{authTab === "login" ? "Sign In to Account" : "Create Customer Account"}</h2>

            <div className="dialog-tabs">
              <button
                type="button"
                className={`dialog-tab ${authTab === "login" ? "active" : ""}`}
                onClick={() => {
                  setAuthTab("login");
                  setAuthError("");
                }}
                id="tab-auth-login"
              >
                Log In
              </button>
              <button
                type="button"
                className={`dialog-tab ${authTab === "register" ? "active" : ""}`}
                onClick={() => {
                  setAuthTab("register");
                  setAuthError("");
                }}
                id="tab-auth-register"
              >
                Create Account
              </button>
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
                ? "Processing..."
                : authTab === "login"
                ? "Sign In"
                : "Create Account"}{" "}
              <span>→</span>
            </button>

            {authTab === "login" && (
              <div className="demo-account-hint">
                <div>
                  <strong>Admin demo account:</strong>
                  <div style={{ color: "var(--color-text-muted)" }}>admin@surgecart.local</div>
                </div>
                <button
                  type="button"
                  onClick={handleAdminQuickFill}
                  id="btn-quick-fill-admin"
                >
                  ⚡ Fill Admin Credentials
                </button>
              </div>
            )}
          </form>
        </div>
      )}

      {/* Order Confirmation Modal */}
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
            <p className="eyebrow">PAYMENT CONFIRMED</p>
            <h2>Thank You for Your Order!</h2>
            <p className="hero-copy" style={{ margin: "8px auto 16px" }}>
              Your limited-drop allocation has been locked and confirmed.
            </p>

            <div className="order-success-number">{completedOrder.orderNumber}</div>

            <div className="order-success-details">
              <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "8px" }}>
                <span>Total Paid:</span>
                <b>{formatPrice(completedOrder.totalCents / 100)}</b>
              </div>
              <div style={{ display: "flex", justifyContent: "space-between" }}>
                <span>Payment Provider:</span>
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

      {/* Floating Toast Notification Container */}
      <div className="toast-container" aria-live="polite">
        {toasts.map((toast) => (
          <div className="toast" key={toast.id}>
            <div className="toast-content">
              <span>{toast.type === "error" ? "⚠️" : toast.type === "success" ? "✓" : "ℹ️"}</span>
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
