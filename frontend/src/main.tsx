import { FormEvent, useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";

type Product = { id: string; name: string; price: number; badge: string; color: string };
type ApiProduct = { id: string; name: string; price_cents: number };
type Session = { token: string; role: string; displayName: string };

const fallbackProducts: Product[] = [
  { id: "sneaker", name: "Transit Runner", price: 129, badge: "Limited 150", color: "sand" },
  { id: "speaker", name: "Pulse Mini", price: 79, badge: "New drop", color: "blue" },
  { id: "bag", name: "Weekender 02", price: 98, badge: "Last chance", color: "orange" },
];
const colors = ["sand", "blue", "orange"];
const formatPrice = (value: number) => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(value);

function AdminPanel({ token }: { token: string }) {
  const [summary, setSummary] = useState<{ products: number; orders: number; order_total_cents: number } | null>(null);
  useEffect(() => { void fetch("/api/v1/admin/dashboard", { headers: { Authorization: `Bearer ${token}` } }).then((r) => r.ok ? r.json() : null).then(setSummary).catch(() => setSummary(null)); }, [token]);
  return <section className="admin" id="admin"><p className="eyebrow">ADMIN DASHBOARD</p><h2>Store overview</h2>{summary ? <div className="admin-stats"><p><b>{summary.products}</b>Products</p><p><b>{summary.orders}</b>Orders</p><p><b>{formatPrice(summary.order_total_cents / 100)}</b>Sales</p></div> : <p>Start the API and sign in as an administrator to load live store data.</p>}<p className="fine">Use the documented admin API to create products, restock inventory, and schedule flash sales.</p></section>;
}

function App() {
  const [products, setProducts] = useState<Product[]>(fallbackProducts);
  const [cart, setCart] = useState<Product[]>([]);
  const [cartId, setCartId] = useState<string | null>(null);
  const [showLogin, setShowLogin] = useState(false);
  const [notice, setNotice] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [session, setSession] = useState<Session | null>(null);
  const total = useMemo(() => cart.reduce((sum, item) => sum + item.price, 0), [cart]);

  useEffect(() => {
    void fetch("/api/v1/products").then((response) => response.ok ? response.json() as Promise<ApiProduct[]> : Promise.reject()).then((items) => {
      if (items.length) setProducts(items.map((item, index) => ({ id: item.id, name: item.name, price: item.price_cents / 100, badge: index === 0 ? "Limited drop" : "Available now", color: colors[index % colors.length] })));
    }).catch(() => undefined);
  }, []);

  async function add(product: Product) {
    setCart((items) => [...items, product]);
    try {
      let activeCart = cartId;
      if (!activeCart) {
        const created = await fetch("/api/v1/carts", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({}) }).then((r) => r.json() as Promise<{ id: string }>);
        activeCart = created.id;
        setCartId(activeCart);
      }
      const response = await fetch(`/api/v1/carts/${activeCart}/items`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ product_id: product.id, quantity: 1 }) });
      if (!response.ok) throw new Error();
      setNotice(`${product.name} was added and saved to your bag.`);
    } catch { setNotice(`${product.name} was added to your bag. Start the API to persist it.`); }
  }

  async function checkout() {
    if (!cart.length) return setNotice("Add an item before checking out.");
    if (!cartId) return setNotice("Start the API, then add an item to create a checkout bag.");
    try {
      const order = await fetch(`/api/v1/orders/checkout/${cartId}`, { method: "POST" }).then(async (r) => r.ok ? r.json() : Promise.reject(await r.json()));
      const paid = await fetch(`/api/v1/orders/${order.id}/pay`, { method: "POST" }).then(async (r) => r.ok ? r.json() : Promise.reject(await r.json()));
      setNotice(`Order ${paid.order_number} is paid. Thank you for shopping SurgeCart.`);
      setCart([]);
    } catch { setNotice("Checkout could not be completed. Your reserved product may have sold out."); }
  }

  async function signIn(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const response = await fetch("/api/v1/auth/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email, password }) });
    if (!response.ok) return setNotice("We could not sign you in. Check your details and make sure the API is running.");
    const data = await response.json() as { access_token: string; user: { role: string; display_name: string } };
    setSession({ token: data.access_token, role: data.user.role, displayName: data.user.display_name });
    setShowLogin(false);
    setNotice(`Welcome back, ${data.user.display_name}.`);
  }

  return <>
    <header className="nav"><a className="brand" href="#top">surge<span>cart</span></a><nav aria-label="Primary"><a href="#drops">Drops</a><a href="#how">How it works</a>{session?.role === "admin" && <a href="#admin">Admin</a>}<button onClick={() => setShowLogin(true)}>{session ? session.displayName : "Log in"}</button></nav><button className="bag" onClick={() => void checkout()}>Bag <b>{cart.length}</b></button></header>
    <main id="top">
      <section className="hero"><div><p className="eyebrow">TODAY'S FEATURED DROP</p><h1>Get there<br /><em>first.</em></h1><p className="hero-copy">Thoughtful goods. Limited runs. A checkout designed to be fair when demand is high.</p><a className="button" href="#drops">Shop the drop <span>→</span></a></div><div className="hero-card"><p>DROP 07</p><strong>08:00</strong><span>hours remaining</span><div className="orb" /></div></section>
      <section id="drops" className="products"><div className="section-heading"><div><p className="eyebrow">SHOP NOW</p><h2>Made for the moment.</h2></div><p>Every item is released in a small quantity. When it’s gone, it’s gone.</p></div><div className="grid">{products.map((product) => <article key={product.id} className="product"><div className={`product-image ${product.color}`}><span>{product.badge}</span><div className="shape" /></div><div className="product-info"><div><h3>{product.name}</h3><p>SurgeCart studio edition</p></div><strong>{formatPrice(product.price)}</strong></div><button onClick={() => void add(product)}>Add to bag <span>+</span></button></article>)}</div></section>
      <section id="how" className="steps"><p className="eyebrow">A FAIRER DROP</p><h2>Quick, clear, and<br />built for everyone.</h2><div className="step-grid"><p><b>01</b>Limited inventory is shown clearly before you buy.</p><p><b>02</b>Your item is held briefly while you check out.</p><p><b>03</b>Secure payment confirms the order. Simple as that.</p></div></section>
      <section className="checkout"><div><p className="eyebrow">YOUR BAG</p><h2>{cart.length ? `${cart.length} item${cart.length > 1 ? "s" : ""} · ${formatPrice(total)}` : "Your bag is waiting."}</h2>{notice && <p className="notice" role="status">{notice}</p>}</div><button className="button" onClick={() => void checkout()}>Checkout <span>→</span></button></section>
      {session?.role === "admin" && <AdminPanel token={session.token} />}
    </main>
    <footer><a className="brand" href="#top">surge<span>cart</span></a><p>Limited drops, fairly sold.</p><a href="mailto:hello@surgecart.local">Contact</a></footer>
    {showLogin && <div className="dialog-backdrop" role="presentation"><form className="dialog" onSubmit={(event) => void signIn(event)}><button type="button" className="close" onClick={() => setShowLogin(false)}>×</button><p className="eyebrow">WELCOME BACK</p><h2>Sign in to SurgeCart</h2><label>Email<input required type="email" value={email} onChange={(event) => setEmail(event.target.value)} placeholder="you@example.com" /></label><label>Password<input required type="password" value={password} onChange={(event) => setPassword(event.target.value)} placeholder="••••••••" /></label><button className="button" type="submit">Log in <span>→</span></button><p className="fine">New customer accounts can be created through the API.</p></form></div>}
  </>;
}

createRoot(document.getElementById("root")!).render(<App />);
