import { FormEvent, useState } from "react";

type ProductBasic = {
  id: string;
  name: string;
  price: number;
  salePrice?: number;
  sku: string;
  imageUrl?: string;
  flashSale?: {
    flash_sale_id: string;
    sale_price_cents: number;
  } | null;
};

type RestockWaitlistModalProps = {
  isOpen: boolean;
  product: ProductBasic | null;
  userEmail?: string;
  onClose: () => void;
  onJoined: (position: number, productName: string) => void;
};

export function RestockWaitlistModal({
  isOpen,
  product,
  userEmail = "",
  onClose,
  onJoined,
}: RestockWaitlistModalProps) {
  const [email, setEmail] = useState(userEmail);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [joinedResult, setJoinedResult] = useState<{ position: number; already: boolean } | null>(null);

  if (!isOpen || !product) return null;

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError("");
    setIsSubmitting(true);

    try {
      const res = await fetch("/api/v1/waitlist/join", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          product_id: product.id,
          flash_sale_id: product.flashSale?.flash_sale_id || null,
          email: email.trim(),
        }),
      });

      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        throw new Error(d.detail || "Could not join waitlist.");
      }

      const data = await res.json();
      setJoinedResult({
        position: data.position,
        already: data.already_joined,
      });
      onJoined(data.position, product.name);
    } catch (err: unknown) {
      setError((err as Error).message || "Failed to join waitlist.");
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleClose = () => {
    setJoinedResult(null);
    setError("");
    onClose();
  };

  return (
    <div className="modal-backdrop" onClick={handleClose} id="waitlist-modal-backdrop">
      <div
        className="waiting-room-dialog waitlist-dialog"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="waitlist-title"
      >
        <div className="waiting-room-header">
          <div className="wr-badge">Automated Restock Alerts</div>
          <h2 id="waitlist-title" className="wr-heading">
            Join Restock Waitlist
          </h2>
          <p className="wr-subtitle">
            This flash sale drop sold out in seconds! When shoppers abandon carts, their
            <strong> 10-minute reservation holds expire unpurchased</strong>. Join the waitlist to receive an
            instant alert and claim freed units before general restock.
          </p>
        </div>

        <div className="waitlist-product-preview">
          {product.imageUrl && (
            <img src={product.imageUrl} alt={product.name} className="waitlist-img" />
          )}
          <div className="waitlist-product-info">
            <h4 className="waitlist-name">{product.name}</h4>
            <div className="waitlist-sku">SKU: {product.sku}</div>
            <div className="waitlist-price">
              {product.salePrice ? `$${product.salePrice.toFixed(2)} (Flash Sale)` : `$${product.price.toFixed(2)}`}
            </div>
          </div>
        </div>

        {joinedResult ? (
          <div className="waitlist-success-pane">
            <div className="waitlist-pos-badge">
              <span className="pos-label">Your Queue Position</span>
              <span className="pos-number">#{joinedResult.position}</span>
            </div>
            <p className="waitlist-success-text">
              {joinedResult.already
                ? `You are already registered on the waitlist at Position #${joinedResult.position}.`
                : `Success! You are now #${joinedResult.position} on the priority restock waitlist.`}
              {" "}We will alert you the moment a 10-minute cart hold expires!
            </p>
            <button className="admin-btn" onClick={handleClose} id="btn-close-waitlist-success">
              Done
            </button>
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="waitlist-form">
            {error && <div className="auth-error">{error}</div>}

            <div className="form-group">
              <label htmlFor="waitlist-email-input" className="form-label">
                Notification Email Address
              </label>
              <input
                id="waitlist-email-input"
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="name@example.com"
                className="modal-input"
              />
            </div>

            <div className="waitlist-benefits">
              <div>&bull; Priority FIFO position when 10-minute cart holds expire</div>
              <div>&bull; Exclusive 10-minute claim window to complete purchase</div>
              <div>&bull; Zero obligation — reservation automatically passes to next in line</div>
            </div>

            <div className="wr-actions">
              <button
                type="submit"
                className="admin-btn"
                disabled={isSubmitting}
                id="btn-submit-waitlist"
              >
                {isSubmitting ? "Joining..." : "Join Priority Waitlist"}
              </button>
              <button
                type="button"
                className="admin-btn secondary"
                onClick={handleClose}
                id="btn-cancel-waitlist"
              >
                Cancel
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
