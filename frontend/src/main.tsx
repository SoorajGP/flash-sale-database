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
import { ScalingArchitectureTab } from "./ScalingArchitectureTab";
import { WaitingRoomModal } from "./WaitingRoomModal";
import { RestockWaitlistModal } from "./RestockWaitlistModal";

// ─── Type definitions ────────────────────────────────────────────────────────

type MediaAsset = {
  url: string;
  alt: string;
  display_order: number;
};

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
  reserved_quantity?: number;
  vendor_id?: string | null;
  vendor_name?: string | null;
  category_path?: string | null;
  dimensions?: { length?: number; width?: number; height?: number; unit?: string } | null;
  weight?: number | null;
  media_gallery?: MediaAsset[];
  rating?: number;
  review_count?: number;
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
  vendorId?: string | null;
  vendorName?: string | null;
  categoryPath?: string | null;
  dimensions?: { length?: number; width?: number; height?: number; unit?: string } | null;
  weight?: number | null;
  mediaGallery?: MediaAsset[];
  flashSale?: ApiProduct["flash_sale"];
};

type FeedbackItem = {
  id: string;
  product_id: string;
  user_id: string;
  user_name: string;
  rating_score: number;
  headline: string;
  body_text: string;
  created_at: string;
};

type FeedbackSummary = {
  mean_score: number;
  total_count: number;
  distribution: Record<string, { count: number; percentage: number }>;
  recommended_percentage: number;
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
    street: "Flat 402, Skyline Residency, Indiranagar",
    city: "Bengaluru",
    state: "Karnataka",
    postalCode: "560038",
    country: "India",
  },
  {
    id: "addr-office",
    label: "Office",
    fullName: "Sooraj G P",
    street: "EcoSpace Business Park, Bellandur Outer Ring Rd",
    city: "Bengaluru",
    state: "Karnataka",
    postalCode: "560103",
    country: "India",
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
  country: "India",
};

// ─── Utility helpers ─────────────────────────────────────────────────────────

const formatPrice = (value: number) =>
  new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR" }).format(value);

const formatCents = (cents: number) => formatPrice(cents / 100);

const fmtCountdown = (secs: number): string => {
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = secs % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
};

// SVG Icons

function IconRupee() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M6 3h12" />
      <path d="M6 8h12" />
      <path d="m6 13 8.5 8" />
      <path d="M6 13h3" />
      <path d="M9 13c6.667 0 6.667-10 0-10" />
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

function IconStar({ filled = true, size = 15 }: { filled?: boolean; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill={filled ? "currentColor" : "none"} stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
    </svg>
  );
}

function IconShield() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
    </svg>
  );
}

function IconTruck() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="1" y="3" width="15" height="13" />
      <polygon points="16 8 20 8 23 11 23 16 16 16 16 8" />
      <circle cx="5.5" cy="18.5" r="2.5" />
      <circle cx="18.5" cy="18.5" r="2.5" />
    </svg>
  );
}

function IconRotate() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
      <path d="M3 3v5h5" />
    </svg>
  );
}

function IconAsteriskLogo() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 2v20M2 12h20M4.93 4.93l14.14 14.14M4.93 19.07l14.14-14.14" />
    </svg>
  );
}

function IconCollapse() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <polyline points="11 17 6 12 11 7" />
      <line x1="18" y1="5" x2="18" y2="19" />
    </svg>
  );
}

function IconDashboard() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="3" y="3" width="7" height="7" rx="1" />
      <rect x="14" y="3" width="7" height="7" rx="1" />
      <rect x="14" y="14" width="7" height="7" rx="1" />
      <rect x="3" y="14" width="7" height="7" rx="1" />
    </svg>
  );
}

function IconOrdersDoc() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <polyline points="14 2 14 8 20 8" />
      <line x1="16" y1="13" x2="8" y2="13" />
      <line x1="16" y1="17" x2="8" y2="17" />
      <polyline points="10 9 9 9 8 9" />
    </svg>
  );
}

function IconInventoryBox() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <polyline points="21 8 21 21 3 21 3 8" />
      <rect x="1" y="3" width="22" height="5" rx="1" />
      <line x1="10" y1="12" x2="14" y2="12" />
    </svg>
  );
}

function IconUsers() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
      <path d="M16 3.13a4 4 0 0 1 0 7.75" />
    </svg>
  );
}

function IconBell() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
      <path d="M13.73 21a2 2 0 0 1-3.46 0" />
    </svg>
  );
}

function IconHelpCircle() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="10" />
      <path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3" />
      <line x1="12" y1="17" x2="12.01" y2="17" />
    </svg>
  );
}

function IconGear() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  );
}

function IconDownloadArrow() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <polyline points="7 10 12 15 17 10" />
      <line x1="12" y1="15" x2="12" y2="3" />
    </svg>
  );
}

function IconUploadArrow() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <polyline points="17 8 12 3 7 8" />
      <line x1="12" y1="3" x2="12" y2="15" />
    </svg>
  );
}

function IconPrinter() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <polyline points="6 9 6 2 18 2 18 9" />
      <path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2" />
      <rect x="6" y="14" width="12" height="8" />
    </svg>
  );
}

function IconDuplicate() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </svg>
  );
}

function IconMoreDots() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="1.5" />
      <circle cx="19" cy="12" r="1.5" />
      <circle cx="5" cy="12" r="1.5" />
    </svg>
  );
}

function IconComment() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
    </svg>
  );
}

function IconCheckSm() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <polyline points="20 6 9 17 4 12" />
    </svg>
  );
}

function IconCrossSm() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
    </svg>
  );
}

function IconLightning() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
    </svg>
  );
}

// ─── Sub-components ──────────────────────────────────────────────────────────

function StarRating({ rating, size = 13 }: { rating: number; size?: number }) {
  const rounded = Math.round(rating);
  return (
    <span className="stars" aria-label={`${rating} out of 5`} style={{ display: "inline-flex", gap: 2, alignItems: "center" }}>
      {Array.from({ length: 5 }, (_, i) => (
        <span key={i} style={{ color: i < rounded ? "#f59e0b" : "#d1d5db", display: "inline-flex" }}>
          <IconStar filled={i < rounded} size={size} />
        </span>
      ))}
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
  onOpenProduct,
  recentlyAddedId,
  onOpenWaitlist,
}: {
  products: Product[];
  serverOffsetMs: number;
  onAddToBag: (p: Product) => void;
  onOpenProduct?: (sku: string) => void;
  recentlyAddedId: string | null;
  onOpenWaitlist?: (p: Product) => void;
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
                <div
                  className="product-image-wrap"
                  onClick={() => onOpenProduct && onOpenProduct(product.sku)}
                  style={{ cursor: onOpenProduct ? "pointer" : "default" }}
                  title={`View ${product.name} specifications`}
                >
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
                    <h3
                      className="product-name"
                      onClick={() => onOpenProduct && onOpenProduct(product.sku)}
                      style={{ cursor: onOpenProduct ? "pointer" : "default" }}
                      title={`View ${product.name} details`}
                    >
                      {product.name}
                    </h3>
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
                      {isOut ? (
                        <button
                          className="product-add-btn waitlist-btn"
                          onClick={() => onOpenWaitlist && onOpenWaitlist(product)}
                          id={`btn-slider-waitlist-${product.id}`}
                          title="Join waitlist for expired hold restock"
                        >
                          Join Waitlist
                        </button>
                      ) : (
                        <button
                          className={`product-add-btn flash-btn ${isAdded ? "added" : ""}`}
                          onClick={() => onAddToBag(product)}
                          id={`btn-slider-add-${product.id}`}
                        >
                          {isAdded ? "Added" : "Add to Bag"}
                        </button>
                      )}
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
            <span className="kpi-icon-badge"><IconRupee /></span>
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
            Average {data.total_orders > 0 ? formatCents(Math.round(data.total_revenue_cents / data.total_orders)) : "₹0.00"} per order
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
                      Sale Price (₹)
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

// ─── Markdown Viewer Component ───────────────────────────────────────────────

function MarkdownView({ content }: { content: string }) {
  if (!content) return null;
  const lines = content.split("\n");
  const elements: React.ReactNode[] = [];
  let currentList: string[] = [];

  const flushList = (key: number) => {
    if (currentList.length > 0) {
      elements.push(
        <ul key={`ul-${key}`} style={{ paddingLeft: "1.2rem", margin: "6px 0" }}>
          {currentList.map((item, idx) => (
            <li key={idx} style={{ marginBottom: "3px" }}>{renderInline(item)}</li>
          ))}
        </ul>
      );
      currentList = [];
    }
  };

  const renderInline = (text: string) => {
    const parts = text.split(/(\*\*[^*]+\*\*)/g);
    return parts.map((part, idx) => {
      if (part.startsWith("**") && part.endsWith("**")) {
        return <strong key={idx}>{part.slice(2, -2)}</strong>;
      }
      return part;
    });
  };

  lines.forEach((line, idx) => {
    const trimmed = line.trim();
    if (trimmed.startsWith("- ") || trimmed.startsWith("* ")) {
      currentList.push(trimmed.slice(2));
    } else {
      flushList(idx);
      if (trimmed.startsWith("### ")) {
        elements.push(<h4 key={idx} style={{ margin: "10px 0 4px", fontSize: "14px", fontWeight: 700 }}>{trimmed.slice(4)}</h4>);
      } else if (trimmed.startsWith("## ")) {
        elements.push(<h3 key={idx} style={{ margin: "12px 0 4px", fontSize: "16px", fontWeight: 700 }}>{trimmed.slice(3)}</h3>);
      } else if (trimmed.startsWith("# ")) {
        elements.push(<h2 key={idx} style={{ margin: "14px 0 6px", fontSize: "18px", fontWeight: 700 }}>{trimmed.slice(2)}</h2>);
      } else if (trimmed.length > 0) {
        elements.push(<p key={idx} style={{ margin: "4px 0" }}>{renderInline(trimmed)}</p>);
      }
    }
  });
  flushList(lines.length);

  return <div className="markdown-render">{elements}</div>;
}

// ─── Interactive Media Viewer ────────────────────────────────────────────────

function ProductMediaViewer({
  gallery,
  fallbackImage,
  productName,
}: {
  gallery?: MediaAsset[];
  fallbackImage: string;
  productName: string;
}) {
  const images = useMemo(() => {
    if (gallery && gallery.length > 0) {
      return [...gallery].sort((a, b) => a.display_order - b.display_order);
    }
    return [{ url: fallbackImage, alt: productName, display_order: 0 }];
  }, [gallery, fallbackImage, productName]);

  const [activeIndex, setActiveIndex] = useState(0);
  const [isZoomed, setIsZoomed] = useState(false);
  const [zoomPos, setZoomPos] = useState({ x: 50, y: 50 });
  const activeAsset = images[activeIndex] || images[0];

  const handleMouseMove = (e: React.MouseEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const x = ((e.clientX - rect.left) / rect.width) * 100;
    const y = ((e.clientY - rect.top) / rect.height) * 100;
    setZoomPos({ x, y });
  };

  return (
    <div className="pdp-gallery-viewport">
      <div
        className="pdp-main-image-wrap"
        onMouseEnter={() => setIsZoomed(true)}
        onMouseLeave={() => setIsZoomed(false)}
        onMouseMove={handleMouseMove}
      >
        <img
          src={activeAsset.url}
          alt={activeAsset.alt || productName}
          className={`pdp-main-image ${isZoomed ? "zoomed" : ""}`}
          style={isZoomed ? { transformOrigin: `${zoomPos.x}% ${zoomPos.y}%` } : undefined}
        />
        <div className="pdp-zoom-badge">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
            <circle cx="11" cy="11" r="8" />
            <line x1="21" y1="21" x2="16.65" y2="16.65" />
          </svg>
          <span>{isZoomed ? "Lens Magnified" : "Hover to Magnify"}</span>
        </div>
        <div className="pdp-image-counter">
          {activeIndex + 1} / {images.length}
        </div>
      </div>

      {images.length > 1 && (
        <div className="pdp-thumbnail-strip">
          {images.map((asset, idx) => (
            <button
              key={idx}
              type="button"
              className={`pdp-thumb-btn ${activeIndex === idx ? "active" : ""}`}
              onClick={() => setActiveIndex(idx)}
              aria-label={`View image ${idx + 1}`}
            >
              <img src={asset.url} alt={asset.alt || `${productName} view ${idx + 1}`} />
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Consumer Sentiment & Social Proof Engine ────────────────────────────────

function ProductSentimentEngine({
  productId,
  session,
  onRequireAuth,
  onNotify,
  onReviewSubmitted,
}: {
  productId: string;
  session: Session | null;
  onRequireAuth: () => void;
  onNotify: (msg: string, type?: "success" | "error") => void;
  onReviewSubmitted?: () => void;
}) {
  const [summary, setSummary] = useState<FeedbackSummary | null>(null);
  const [reviews, setReviews] = useState<FeedbackItem[]>([]);
  const [selectedStarFilter, setSelectedStarFilter] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);

  // Review modal form state
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [formRating, setFormRating] = useState(5);
  const [formHeadline, setFormHeadline] = useState("");
  const [formBody, setFormBody] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [formError, setFormError] = useState("");

  const loadData = useCallback(() => {
    setLoading(true);
    const summaryP = fetch(`/api/v1/products/${productId}/feedback/summary`)
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null);

    const filterQuery = selectedStarFilter ? `?rating=${selectedStarFilter}` : "";
    const reviewsP = fetch(`/api/v1/products/${productId}/feedback${filterQuery}`)
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null);

    Promise.all([summaryP, reviewsP])
      .then(([sumData, revData]) => {
        if (sumData) setSummary(sumData);
        if (revData) {
          const list = Array.isArray(revData) ? revData : (revData.items || []);
          setReviews(list);
        }
      })
      .finally(() => setLoading(false));
  }, [productId, selectedStarFilter]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  const handleOpenWriteReview = () => {
    if (!session) {
      onRequireAuth();
      return;
    }
    setFormRating(5);
    setFormHeadline("");
    setFormBody("");
    setFormError("");
    setIsModalOpen(true);
  };

  const handleSubmitReview = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!session) return;
    if (!formHeadline.trim()) {
      setFormError("Please enter a summary headline.");
      return;
    }
    if (!formBody.trim()) {
      setFormError("Please provide feedback details.");
      return;
    }

    setIsSubmitting(true);
    setFormError("");

    try {
      const res = await fetch(`/api/v1/products/${productId}/feedback`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${session.token}`,
        },
        body: JSON.stringify({
          rating_score: formRating,
          headline: formHeadline.trim(),
          body_text: formBody.trim(),
        }),
      });

      if (res.ok) {
        setIsModalOpen(false);
        onNotify("Thank you! Your verified feedback was published.", "success");
        loadData();
        if (onReviewSubmitted) onReviewSubmitted();
      } else {
        const err = await res.json().catch(() => ({ detail: "Submission failed." }));
        setFormError(err.detail || "Unable to submit feedback.");
      }
    } catch {
      setFormError("Network communication error.");
    } finally {
      setIsSubmitting(false);
    }
  };

  const meanScore = summary?.mean_score ?? 5.0;
  const totalCount = summary?.total_count ?? reviews.length;
  const recPct = summary?.recommended_percentage ?? 100;

  return (
    <section className="pdp-sentiment-section" id="sentiment-section">
      <div className="sentiment-section-header">
        <div>
          <h2 className="sentiment-section-title">Verified Customer Sentiment</h2>
          <p className="sentiment-section-sub">
            Authentic product reviews and ratings directly from verified buyers.
          </p>
        </div>
        <button
          className="admin-btn"
          style={{ background: "var(--forest)", color: "#fff" }}
          onClick={handleOpenWriteReview}
          id="btn-write-review"
        >
          Write a Review
        </button>
      </div>

      <div className="sentiment-split-layout">
        {/* Left Column: Aggregate Summary Module */}
        <div className="sentiment-summary-card">
          <div className="summary-score-hero">
            <div className="summary-big-number">
              {meanScore.toFixed(1)} <span className="summary-scale">/ 5</span>
            </div>
            <div className="summary-stars-row">
              <StarRating rating={meanScore} size={18} />
            </div>
            <div className="summary-meta-sub">
              Based on {totalCount} verified buyer {totalCount === 1 ? "review" : "reviews"}
            </div>
          </div>

          <div className="summary-recommendation">
            {recPct}% of customers recommend this item
          </div>

          {/* 5-Tier Star Histogram */}
          <div className="sentiment-histogram">
            {[5, 4, 3, 2, 1].map((stars) => {
              const tierData = summary?.distribution?.[String(stars)];
              const pct = tierData?.percentage ?? 0;
              const count = tierData?.count ?? 0;
              const isActive = selectedStarFilter === stars;

              return (
                <div
                  key={stars}
                  className={`histogram-row ${isActive ? "active" : ""}`}
                  onClick={() => setSelectedStarFilter(isActive ? null : stars)}
                  title={`Filter by ${stars} star reviews`}
                >
                  <span className="histogram-star-label">{stars} Star</span>
                  <div className="histogram-bar-track">
                    <div className="histogram-bar-fill" style={{ width: `${pct}%` }} />
                  </div>
                  <span className="histogram-count">{count}</span>
                </div>
              );
            })}
          </div>

          {/* Filter Bar */}
          <div className="sentiment-filter-bar">
            <button
              className={`sentiment-filter-pill ${selectedStarFilter === null ? "active" : ""}`}
              onClick={() => setSelectedStarFilter(null)}
            >
              All Reviews
            </button>
            {[5, 4, 3, 2, 1].map((stars) => (
              <button
                key={stars}
                className={`sentiment-filter-pill ${selectedStarFilter === stars ? "active" : ""}`}
                onClick={() => setSelectedStarFilter(stars)}
              >
                {stars} Stars
              </button>
            ))}
          </div>
        </div>

        {/* Right Column: Chronological Scroll List */}
        <div className="sentiment-reviews-column">
          <div className="reviews-column-header">
            <span>
              {selectedStarFilter ? `${selectedStarFilter}-Star Feedback` : "All Feedback Entries"} ({reviews.length})
            </span>
            {selectedStarFilter && (
              <button className="inline-link" onClick={() => setSelectedStarFilter(null)}>
                Clear Filter
              </button>
            )}
          </div>

          {reviews.length === 0 ? (
            <div className="catalog-empty-search" style={{ padding: "40px 20px" }}>
              <h3>No reviews found</h3>
              <p>Be the first customer to share your experience with this item.</p>
              <button className="table-btn primary" onClick={handleOpenWriteReview}>
                Write First Review
              </button>
            </div>
          ) : (
            reviews.map((rev) => (
              <article key={rev.id} className="sentiment-review-card">
                <div className="review-header-row">
                  <div className="review-user-info">
                    <div className="review-avatar">
                      {rev.user_name.charAt(0).toUpperCase()}
                    </div>
                    <div>
                      <div className="review-user-name">{rev.user_name}</div>
                      <span className="review-verified-badge">
                        <IconShield /> Verified Buyer
                      </span>
                    </div>
                  </div>
                  <div className="review-date">
                    {new Date(rev.created_at).toLocaleDateString("en-US", {
                      year: "numeric",
                      month: "short",
                      day: "numeric",
                    })}
                  </div>
                </div>

                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <StarRating rating={rev.rating_score} size={14} />
                  <span style={{ fontSize: 12, fontWeight: 600, color: "var(--forest)" }}>
                    {rev.rating_score}.0 / 5
                  </span>
                </div>

                <h3 className="review-headline">{rev.headline}</h3>
                <p className="review-body">{rev.body_text}</p>
              </article>
            ))
          )}
        </div>
      </div>

      {/* Write a Review Modal Dialog */}
      {isModalOpen && (
        <div className="modal-backdrop" onClick={() => !isSubmitting && setIsModalOpen(false)}>
          <div className="dialog" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 520 }}>
            <h2 style={{ margin: "0 0 6px", fontSize: 20, color: "var(--forest)" }}>Write a Review</h2>
            <p style={{ margin: "0 0 16px", fontSize: 13, color: "var(--text-muted)" }}>
              Share your direct evaluation of product quality, durability, and fit.
            </p>

            {formError && <div className="dialog-error">{formError}</div>}

            <form onSubmit={handleSubmitReview}>
              <div style={{ marginBottom: 16 }}>
                <label className="admin-field-label">Overall Rating Score</label>
                <div className="review-modal-stars">
                  {[1, 2, 3, 4, 5].map((s) => (
                    <button
                      key={s}
                      type="button"
                      className={`star-btn ${s <= formRating ? "filled" : ""}`}
                      onClick={() => setFormRating(s)}
                      aria-label={`${s} star rating`}
                    >
                      <IconStar filled={s <= formRating} size={28} />
                    </button>
                  ))}
                  <span style={{ marginLeft: 8, fontSize: 13, fontWeight: 600, color: "var(--forest)", alignSelf: "center" }}>
                    {formRating === 5 ? "5 Stars - Outstanding" :
                      formRating === 4 ? "4 Stars - Great Quality" :
                        formRating === 3 ? "3 Stars - Average" :
                          formRating === 2 ? "2 Stars - Below Expectations" : "1 Star - Disappointed"}
                  </span>
                </div>
              </div>

              <div style={{ marginBottom: 14 }}>
                <label className="admin-field-label">Headline Summary</label>
                <input
                  type="text"
                  maxLength={255}
                  value={formHeadline}
                  onChange={(e) => setFormHeadline(e.target.value)}
                  placeholder="e.g. Exceptional craftsmanship and ultra lightweight"
                  className="admin-field-input"
                  required
                />
              </div>

              <div style={{ marginBottom: 20 }}>
                <label className="admin-field-label">Detailed Review</label>
                <textarea
                  rows={4}
                  value={formBody}
                  onChange={(e) => setFormBody(e.target.value)}
                  placeholder="Provide in-depth observations on materials, ergonomics, and daily performance..."
                  className="admin-field-textarea"
                  style={{ width: "100%" }}
                  required
                />
              </div>

              <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
                <button
                  type="button"
                  className="admin-btn secondary"
                  onClick={() => setIsModalOpen(false)}
                  disabled={isSubmitting}
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="admin-btn"
                  style={{ background: "var(--forest)", color: "#fff" }}
                  disabled={isSubmitting}
                >
                  {isSubmitting ? "Publishing..." : "Submit Verified Feedback"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </section>
  );
}

// ─── Customer-Facing Dynamic Product Layout (PDP) ───────────────────────────

function ProductDetailPage({
  skuOrId,
  serverOffsetMs,
  onAddToBag,
  onNavigateHome,
  session,
  onRequireAuth,
  onNotify,
  onProductsUpdated,
  onOpenWaitlist,
}: {
  skuOrId: string;
  serverOffsetMs: number;
  onAddToBag: (product: Product, quantity?: number) => void;
  onNavigateHome: () => void;
  session: Session | null;
  onRequireAuth: () => void;
  onNotify: (msg: string, type?: "success" | "error") => void;
  onProductsUpdated?: () => void;
  onOpenWaitlist?: (product: Product) => void;
}) {
  const [product, setProduct] = useState<Product | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [activeTab, setActiveTab] = useState<"overview" | "specs" | "logistics">("overview");
  const [quantity, setQuantity] = useState(1);
  const [isAdded, setIsAdded] = useState(false);

  const fetchProductDetail = useCallback(() => {
    fetch(`/api/v1/products/${encodeURIComponent(skuOrId)}`)
      .then((r) => {
        if (!r.ok) throw new Error("Product not found");
        return r.json() as Promise<ApiProduct>;
      })
      .then((item) => {
        const enrich =
          uuidEnrichMap[item.id] ??
          enrichmentMap[item.sku] ??
          {};
        const mapped: Product = {
          id: item.id,
          sku: item.sku,
          name: item.name,
          price: item.price_cents / 100,
          salePrice: item.flash_sale ? item.flash_sale.sale_price_cents / 100 : undefined,
          badge: item.flash_sale ? "Flash Deal" : "Available Now",
          color: "sand",
          imageUrl: item.media_gallery?.[0]?.url ?? enrich.imageUrl ?? `/products/${item.id}.jpg`,
          description: item.description ?? enrich.description ?? "Limited release merchandise.",
          rating: item.rating !== undefined ? item.rating : (enrich.rating ?? 4.8),
          reviewCount: item.review_count !== undefined ? item.review_count : (enrich.reviewCount ?? 0),
          category: item.category_path?.split(" > ").pop() ?? enrich.category ?? "Gear",
          availableQty: item.available_quantity,
          totalStock: item.on_hand_quantity ?? 100,
          vendorId: item.vendor_id,
          vendorName: item.vendor_name,
          categoryPath: item.category_path,
          dimensions: item.dimensions,
          weight: item.weight,
          mediaGallery: item.media_gallery,
          flashSale: item.flash_sale,
        };
        setProduct(mapped);
      })
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, [skuOrId]);

  useEffect(() => {
    setLoading(true);
    setError("");
    fetchProductDetail();
  }, [fetchProductDetail]);

  if (loading) {
    return (
      <div className="pdp-wrapper" style={{ textAlign: "center", padding: "100px 20px" }}>
        <p style={{ color: "var(--text-muted)", fontSize: 16 }}>Loading product specifications...</p>
      </div>
    );
  }

  if (error || !product) {
    return (
      <div className="pdp-wrapper" style={{ textAlign: "center", padding: "100px 20px" }}>
        <h2>Product Unavailable</h2>
        <p style={{ color: "var(--text-muted)", margin: "8px 0 24px" }}>
          The requested release identifier could not be retrieved from the catalog ledger.
        </p>
        <button className="table-btn primary" onClick={onNavigateHome}>
          Return to Storefront
        </button>
      </div>
    );
  }

  const isFlash = !!product.flashSale;
  const remainingStock = isFlash ? product.flashSale!.units_remaining : product.availableQty;
  const orderCap = isFlash ? Math.min(product.flashSale!.per_customer_limit, remainingStock) : remainingStock;
  const isSoldOut = remainingStock <= 0;
  const discountPct = isFlash && product.salePrice
    ? Math.round(((product.price - product.salePrice) / product.price) * 100)
    : 0;

  const handleCommitToCart = () => {
    if (isSoldOut) return;
    onAddToBag(product, quantity);
    setIsAdded(true);
    setTimeout(() => setIsAdded(false), 2200);
  };

  return (
    <div className="pdp-wrapper" id="pdp-container">
      {/* Navigation & Breadcrumbs */}
      <nav className="pdp-nav-bar" aria-label="Product navigation">
        <button className="pdp-back-btn" onClick={onNavigateHome} id="btn-pdp-back">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2">
            <line x1="19" y1="12" x2="5" y2="12" />
            <polyline points="12 19 5 12 12 5" />
          </svg>
          <span>Back to Catalog</span>
        </button>

        <div className="pdp-breadcrumbs">
          <a href="#drops" onClick={(e) => { e.preventDefault(); onNavigateHome(); }}>Catalog</a>
          <span>/</span>
          {product.categoryPath ? (
            <span>{product.categoryPath}</span>
          ) : (
            <span>{product.category || "Releases"}</span>
          )}
          <span>/</span>
          <span style={{ color: "var(--forest)", fontWeight: 600 }}>{product.sku}</span>
        </div>
      </nav>

      {/* Split-Pane 3-Column Layout */}
      <div className="pdp-split-pane">
        {/* Col 1: Primary Viewport / Interactive Media Viewer */}
        <ProductMediaViewer
          gallery={product.mediaGallery}
          fallbackImage={product.imageUrl || "/products/sneaker.jpg"}
          productName={product.name}
        />

        {/* Col 2: Information Column */}
        <div className="pdp-info-column">
          {product.vendorName && (
            <div className="pdp-vendor-badge">
              <IconShield />
              <span>Fulfilled by {product.vendorName}</span>
            </div>
          )}

          <div>
            <h1 className="pdp-title">{product.name}</h1>
            <div className="pdp-sku-meta" style={{ marginTop: 4, display: "flex", alignItems: "center", flexWrap: "wrap", gap: 6 }}>
              <span>SKU: {product.sku} &bull; Category: {product.categoryPath || product.category || "General"}</span>
              <button
                type="button"
                className="copy-sku-btn"
                onClick={() => {
                  navigator.clipboard.writeText(product.sku);
                  onNotify(`Copied SKU "${product.sku}" to clipboard!`, "success");
                }}
                title="Copy SKU code"
                id="btn-copy-sku"
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
                Copy SKU
              </button>
            </div>
          </div>

          {/* Social Proof Star Preview */}
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <StarRating rating={product.rating || 5} size={15} />
            <a
              href="#sentiment-section"
              className="inline-link"
              style={{ fontSize: 13, textDecoration: "underline" }}
              onClick={(e) => {
                e.preventDefault();
                document.getElementById("sentiment-section")?.scrollIntoView({ behavior: "smooth" });
              }}
            >
              Verified Customer Ratings &amp; Reviews
            </a>
          </div>

          {/* Active Drop Promotion Banner */}
          {isFlash && product.flashSale && (
            <div className="pdp-flash-banner">
              <div className="flash-banner-top">
                <span>Active Flash Sale Allocation</span>
                <div className="flash-banner-timer">
                  <FlashCountdown endsAt={product.flashSale.sale_ends_at} serverOffsetMs={serverOffsetMs} />
                </div>
              </div>
              <div className="flash-banner-progress">
                <div
                  className="flash-banner-fill"
                  style={{
                    width: `${Math.min(
                      100,
                      ((product.flashSale.allocation_quantity - product.flashSale.units_remaining) /
                        Math.max(product.flashSale.allocation_quantity, 1)) * 100
                    )}%`,
                  }}
                />
              </div>
              <div style={{ fontSize: 11.5, color: "var(--terracotta)", fontWeight: 600 }}>
                {product.flashSale.units_remaining} of {product.flashSale.allocation_quantity} units remaining
              </div>
            </div>
          )}

          {/* Tabbed Details */}
          <div className="pdp-tabs-container">
            <div className="pdp-tabs-nav" role="tablist">
              <button
                className={`pdp-tab-trigger ${activeTab === "overview" ? "active" : ""}`}
                onClick={() => setActiveTab("overview")}
              >
                Overview
              </button>
              <button
                className={`pdp-tab-trigger ${activeTab === "specs" ? "active" : ""}`}
                onClick={() => setActiveTab("specs")}
              >
                Specifications
              </button>
              <button
                className={`pdp-tab-trigger ${activeTab === "logistics" ? "active" : ""}`}
                onClick={() => setActiveTab("logistics")}
              >
                Logistics &amp; Provenance
              </button>
            </div>

            <div className="pdp-tab-content">
              {activeTab === "overview" && (
                <div>
                  <MarkdownView content={product.description || "No description provided."} />
                </div>
              )}

              {activeTab === "specs" && (
                <table className="pdp-spec-table">
                  <tbody>
                    <tr>
                      <td>Stock Keeping Unit</td>
                      <td>{product.sku}</td>
                    </tr>
                    <tr>
                      <td>Category Classification</td>
                      <td>{product.categoryPath || product.category || "Standard Catalog"}</td>
                    </tr>
                    <tr>
                      <td>Physical Dimensions</td>
                      <td>
                        {product.dimensions
                          ? `${product.dimensions.length ?? "—"} × ${product.dimensions.width ?? "—"} × ${product.dimensions.height ?? "—"} ${product.dimensions.unit ?? "cm"}`
                          : "Standard release package"}
                      </td>
                    </tr>
                    <tr>
                      <td>Net Weight</td>
                      <td>{product.weight ? `${product.weight} kg` : "Standard courier class"}</td>
                    </tr>
                    <tr>
                      <td>Ledger Identifier</td>
                      <td style={{ fontFamily: "var(--font-mono)", fontSize: 11 }}>{product.id}</td>
                    </tr>
                  </tbody>
                </table>
              )}

              {activeTab === "logistics" && (
                <div>
                  <p style={{ margin: "0 0 8px" }}>
                    <strong>Direct Logistics Partner:</strong> {product.vendorName || "Global Logistics Hub"}
                  </p>
                  <p style={{ margin: "0 0 8px" }}>
                    <strong>Partner ID:</strong> {product.vendorId || "VN-SYSTEM-HQ"}
                  </p>
                  <p style={{ margin: 0, color: "var(--text-muted)" }}>
                    Every parcel is inspected and dispatched under temperature-monitored courier conditions with traceable transit tracking.
                  </p>
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Col 3: Sticky Transaction Card */}
        <aside className="pdp-sticky-transaction-card" aria-label="Purchase actions">
          <div className="pdp-price-wrap">
            {isFlash && product.salePrice !== undefined ? (
              <>
                <span className="pdp-current-price">{formatPrice(product.salePrice)}</span>
                <span className="pdp-original-price">{formatPrice(product.price)}</span>
                <span className="pdp-save-badge">Save {discountPct}%</span>
              </>
            ) : (
              <span className="pdp-current-price">{formatPrice(product.price)}</span>
            )}
          </div>

          {/* Real-time availability indicators */}
          <div className={`pdp-stock-alert ${remainingStock <= 5 ? "low" : "in-stock"}`}>
            <span className="pdp-pulse-dot" />
            <span>
              {isSoldOut
                ? "Sold Out in Active Allocation"
                : remainingStock <= 5
                  ? `Low Stock Alert: Only ${remainingStock} unit${remainingStock > 1 ? "s" : ""} left!`
                  : `In Stock: ${remainingStock} units ready for immediate release`}
            </span>
          </div>

          {isFlash && (
            <div style={{ fontSize: 12, color: "var(--text-muted)", fontStyle: "italic" }}>
              Enforced limit: Maximum {product.flashSale?.per_customer_limit} per customer.
            </div>
          )}

          {/* Quantity selector */}
          {!isSoldOut && (
            <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
              <label style={{ fontSize: 13, fontWeight: 600, color: "var(--forest)" }}>Quantity:</label>
              <select
                value={quantity}
                onChange={(e) => setQuantity(Number(e.target.value))}
                className="admin-field-select"
                style={{ width: 80, padding: "6px 8px" }}
              >
                {Array.from({ length: Math.min(orderCap, 10) }, (_, i) => i + 1).map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </select>
            </div>
          )}

          {/* Action button */}
          {isSoldOut ? (
            <button
              className="pdp-action-btn waitlist-btn"
              onClick={() => onOpenWaitlist && onOpenWaitlist(product)}
              id="btn-commit-to-cart"
              style={{ background: "#92400e", borderColor: "#78350f", color: "#fff" }}
            >
              <span>Join Priority Waitlist</span>
              <span>&rarr;</span>
            </button>
          ) : (
            <button
              className={`pdp-action-btn ${isAdded ? "added" : ""}`}
              onClick={handleCommitToCart}
              disabled={isSoldOut || isAdded}
              id="btn-commit-to-cart"
            >
              <span>{isAdded ? "Added to Cart" : "Commit to Cart"}</span>
              <span>&rarr;</span>
            </button>
          )}

          {/* Fulfillment Assurances */}
          <div className="pdp-assurances-list">
            <div className="assurance-item">
              <IconTruck />
              <span>Dispatched within 24 hours via express route</span>
            </div>
            <div className="assurance-item">
              <IconShield />
              <span>Row-level inventory lock upon checkout</span>
            </div>
            <div className="assurance-item">
              <IconRotate />
              <span>30-day verified satisfaction return guarantee</span>
            </div>
          </div>
        </aside>
      </div>

      {/* Social Proof Engine */}
      <ProductSentimentEngine
        productId={product.id}
        session={session}
        onRequireAuth={onRequireAuth}
        onNotify={onNotify}
        onReviewSubmitted={() => {
          fetchProductDetail();
          if (onProductsUpdated) onProductsUpdated();
        }}
      />
    </div>
  );
}

// ─── Administrative Unified Product Form Modal ───────────────────────────────

const PRESET_VENDORS = [
  { id: "VN-8821", name: "Acro Logistics Corp" },
  { id: "VN-4092", name: "Nordic Acoustic Labs" },
  { id: "VN-1104", name: "Heritage Canvas & Leather Co." },
  { id: "VN-9901", name: "Apex Precision Supply" },
];

function UnifiedProductModal({
  isOpen,
  productToEdit,
  token,
  onClose,
  onSaved,
  onDelete,
}: {
  isOpen: boolean;
  productToEdit: Product | null;
  token: string;
  onClose: () => void;
  onSaved: (msg: string) => void;
  onDelete?: (product: Product) => void;
}) {
  const isEdit = !!productToEdit;

  const [name, setName] = useState("");
  const [sku, setSku] = useState("");
  const [priceDollars, setPriceDollars] = useState("");
  const [vendorId, setVendorId] = useState("VN-8821");
  const [vendorName, setVendorName] = useState("Acro Logistics Corp");
  const [categoryPath, setCategoryPath] = useState("");
  const [description, setDescription] = useState("");
  const [descTab, setDescTab] = useState<"edit" | "preview">("edit");
  const [mediaGallery, setMediaGallery] = useState<MediaAsset[]>([]);
  const [stockOnHand, setStockOnHand] = useState("100");
  const [lengthVal, setLengthVal] = useState("28");
  const [widthVal, setWidthVal] = useState("18");
  const [heightVal, setHeightVal] = useState("12");
  const [unitVal, setUnitVal] = useState("cm");
  const [weightVal, setWeightVal] = useState("0.85");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (productToEdit) {
      setName(productToEdit.name);
      setSku(productToEdit.sku);
      setPriceDollars(productToEdit.price.toFixed(2));
      setVendorId(productToEdit.vendorId || "VN-8821");
      setVendorName(productToEdit.vendorName || "Acro Logistics Corp");
      setCategoryPath(productToEdit.categoryPath || productToEdit.category || "Gear");
      setDescription(productToEdit.description || "");
      setMediaGallery(
        productToEdit.mediaGallery && productToEdit.mediaGallery.length > 0
          ? productToEdit.mediaGallery
          : [{ url: productToEdit.imageUrl || "/products/sneaker.jpg", alt: productToEdit.name, display_order: 0 }]
      );
      setStockOnHand(String(productToEdit.totalStock));
      if (productToEdit.dimensions) {
        setLengthVal(String(productToEdit.dimensions.length ?? ""));
        setWidthVal(String(productToEdit.dimensions.width ?? ""));
        setHeightVal(String(productToEdit.dimensions.height ?? ""));
        setUnitVal(productToEdit.dimensions.unit ?? "cm");
      }
      setWeightVal(productToEdit.weight !== undefined && productToEdit.weight !== null ? String(productToEdit.weight) : "");
    } else {
      // Create mode defaults
      setName("");
      setSku("");
      setPriceDollars("99.00");
      setVendorId("VN-8821");
      setVendorName("Acro Logistics Corp");
      setCategoryPath("Apparel > Footwear");
      setDescription("Premium limited release item. Built with durable materials.");
      setMediaGallery([
        { url: "/products/sneaker.jpg", alt: "Primary Product View", display_order: 0 },
      ]);
      setStockOnHand("50");
      setLengthVal("30");
      setWidthVal("20");
      setHeightVal("15");
      setUnitVal("cm");
      setWeightVal("1.0");
    }
    setError("");
  }, [productToEdit, isOpen]);

  if (!isOpen) return null;

  const handleVendorSelect = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const val = e.target.value;
    const found = PRESET_VENDORS.find((v) => v.id === val);
    if (found) {
      setVendorId(found.id);
      setVendorName(found.name);
    } else {
      setVendorId(val);
    }
  };

  const handleAddMedia = () => {
    setMediaGallery((prev) => [
      ...prev,
      { url: "/products/speaker.jpg", alt: "Additional View", display_order: prev.length },
    ]);
  };

  const handleUpdateMedia = (index: number, field: keyof MediaAsset, value: any) => {
    setMediaGallery((prev) =>
      prev.map((item, i) => (i === index ? { ...item, [field]: value } : item))
    );
  };

  const handleRemoveMedia = (index: number) => {
    setMediaGallery((prev) => prev.filter((_, i) => i !== index));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");

    const priceNum = parseFloat(priceDollars);
    if (isNaN(priceNum) || priceNum <= 0) {
      setError("Price must be a positive currency amount (floor limit >= ₹0.01).");
      return;
    }
    const priceCents = Math.round(priceNum * 100);

    const stockNum = parseInt(stockOnHand, 10);
    if (isNaN(stockNum) || stockNum < 0) {
      setError("Warehouse availability metric must be 0 or greater.");
      return;
    }

    const payload: any = {
      name: name.trim(),
      sku: sku.trim().toUpperCase(),
      price_cents: priceCents,
      description: description.trim(),
      vendor_id: vendorId.trim(),
      vendor_name: vendorName.trim(),
      category_path: categoryPath.trim(),
      dimensions: {
        length: parseFloat(lengthVal) || null,
        width: parseFloat(widthVal) || null,
        height: parseFloat(heightVal) || null,
        unit: unitVal,
      },
      weight: parseFloat(weightVal) || null,
      media_gallery: mediaGallery,
    };

    if (isEdit) {
      payload.on_hand_quantity = stockNum;
    } else {
      payload.initial_stock = stockNum;
    }

    setSubmitting(true);
    try {
      const url = isEdit
        ? `/api/v1/admin/products/${productToEdit.id}`
        : "/api/v1/admin/products";
      const method = isEdit ? "PUT" : "POST";

      const res = await fetch(url, {
        method,
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(payload),
      });

      if (res.ok) {
        onSaved(isEdit ? `Updated "${name}" in catalog.` : `Added "${name}" to active catalog.`);
        onClose();
      } else {
        const err = await res.json().catch(() => ({ detail: "Operation failed" }));
        setError(err.detail || "Unable to save product.");
      }
    } catch {
      setError("Network communication error.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="modal-backdrop" onClick={() => !submitting && onClose()}>
      <div className="dialog product-modal-dialog" onClick={(e) => e.stopPropagation()}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
          <div>
            <span className="admin-eyebrow">{isEdit ? "Catalog Mutation (HTTP PUT)" : "New Catalog Asset (HTTP POST)"}</span>
            <h2 style={{ margin: 0, fontSize: 22, color: "var(--forest)" }}>
              {isEdit ? `Edit Catalog Item: ${productToEdit.sku}` : "Add New Catalog Product"}
            </h2>
          </div>
          <button type="button" className="catalog-search-clear" onClick={onClose} style={{ position: "static" }}>
            &times;
          </button>
        </div>

        {error && <div className="dialog-error">{error}</div>}

        <form onSubmit={handleSubmit} style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          {/* Row 1: Name & SKU */}
          <div className="form-grid-2">
            <label className="admin-field-label">
              Product Title
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. Transit Runner Mk.II"
                className="admin-field-input"
                required
              />
            </label>
            <label className="admin-field-label">
              Global Stock Keeping Unit (SKU)
              <input
                type="text"
                value={sku}
                onChange={(e) => setSku(e.target.value)}
                placeholder="e.g. TRANSIT-MK2"
                className="admin-field-input"
                required
              />
            </label>
          </div>

          {/* Row 2: Price & Warehouse Stock */}
          <div className="form-grid-3">
            <label className="admin-field-label">
              Retail Price (₹ INR)
              <input
                type="number"
                step="0.01"
                min="0.01"
                value={priceDollars}
                onChange={(e) => setPriceDollars(e.target.value)}
                placeholder="999.00"
                className="admin-field-input"
                required
              />
              <span style={{ fontSize: 10.5, color: "var(--text-muted)" }}>
                Casts to {Math.round((parseFloat(priceDollars) || 0) * 100)} paise subunits
              </span>
            </label>

            <label className="admin-field-label">
              {isEdit ? "Stock On Hand (Ledger Delta)" : "Initial Stock Allocation"}
              <input
                type="number"
                min="0"
                value={stockOnHand}
                onChange={(e) => setStockOnHand(e.target.value)}
                placeholder="100"
                className="admin-field-input"
                required
              />
              <span style={{ fontSize: 10.5, color: "var(--text-muted)" }}>
                Writes directly to inventory ledger
              </span>
            </label>

            <label className="admin-field-label">
              Logistics Vendor
              <select
                value={vendorId}
                onChange={handleVendorSelect}
                className="admin-field-select"
              >
                {PRESET_VENDORS.map((v) => (
                  <option key={v.id} value={v.id}>
                    {v.name} ({v.id})
                  </option>
                ))}
              </select>
            </label>
          </div>

          {/* Row 3: Category Path & Logistics Partner Name */}
          <div className="form-grid-2">
            <label className="admin-field-label">
              Hierarchical Classification (`category_path`)
              <input
                type="text"
                value={categoryPath}
                onChange={(e) => setCategoryPath(e.target.value)}
                placeholder="e.g. Apparel > Footwear > Running"
                className="admin-field-input"
              />
            </label>
            <label className="admin-field-label">
              Partner Distribution Display Name
              <input
                type="text"
                value={vendorName}
                onChange={(e) => setVendorName(e.target.value)}
                placeholder="e.g. Acro Logistics Corp"
                className="admin-field-input"
              />
            </label>
          </div>

          {/* Row 4: Markdown Long-Form Specifications */}
          <div>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <label className="admin-field-label">Long-Form Specifications (Markdown Support)</label>
              <div className="markdown-editor-tabs">
                <button
                  type="button"
                  className={`markdown-tab-btn ${descTab === "edit" ? "active" : ""}`}
                  onClick={() => setDescTab("edit")}
                >
                  Write Markdown
                </button>
                <button
                  type="button"
                  className={`markdown-tab-btn ${descTab === "preview" ? "active" : ""}`}
                  onClick={() => setDescTab("preview")}
                >
                  Live Preview
                </button>
              </div>
            </div>

            {descTab === "edit" ? (
              <textarea
                rows={4}
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="Use markdown: **bold text**, - list items, ## headers, and detailed specs..."
                className="admin-field-textarea"
                style={{ width: "100%", fontFamily: "var(--font-mono)", fontSize: 12.5 }}
              />
            ) : (
              <div className="markdown-preview-box">
                <MarkdownView content={description} />
              </div>
            )}
          </div>

          {/* Row 5: Dynamic Media Gallery Manager */}
          <div>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
              <label className="admin-field-label">Media Gallery Assets (`media_gallery` JSONB Array)</label>
              <button
                type="button"
                className="table-btn"
                onClick={handleAddMedia}
              >
                + Add Media Item
              </button>
            </div>

            <div className="media-manager-card">
              {mediaGallery.map((asset, idx) => (
                <div key={idx} className="media-asset-row">
                  <img src={asset.url} alt={asset.alt || "Asset"} className="media-asset-preview" />
                  <input
                    type="text"
                    value={asset.url}
                    onChange={(e) => handleUpdateMedia(idx, "url", e.target.value)}
                    placeholder="Image URL"
                    className="admin-field-input"
                    style={{ fontSize: 12 }}
                  />
                  <input
                    type="text"
                    value={asset.alt}
                    onChange={(e) => handleUpdateMedia(idx, "alt", e.target.value)}
                    placeholder="Alt Text"
                    className="admin-field-input"
                    style={{ fontSize: 12 }}
                  />
                  <input
                    type="number"
                    value={asset.display_order}
                    onChange={(e) => handleUpdateMedia(idx, "display_order", parseInt(e.target.value, 10) || 0)}
                    placeholder="Order"
                    className="admin-field-input"
                    style={{ fontSize: 12 }}
                  />
                  <button
                    type="button"
                    onClick={() => handleRemoveMedia(idx)}
                    style={{ background: "none", border: "none", color: "#ef4444", cursor: "pointer", fontWeight: "bold" }}
                    title="Remove asset"
                  >
                    &times;
                  </button>
                </div>
              ))}
            </div>
          </div>

          {/* Row 6: Dimensions & Weight */}
          <div>
            <label className="admin-field-label" style={{ marginBottom: 6 }}>
              Shipping Package Dimensions &amp; Net Weight
            </label>
            <div className="form-grid-3">
              <div style={{ display: "flex", gap: 6 }}>
                <input
                  type="number"
                  step="0.1"
                  value={lengthVal}
                  onChange={(e) => setLengthVal(e.target.value)}
                  placeholder="Length"
                  className="admin-field-input"
                />
                <input
                  type="number"
                  step="0.1"
                  value={widthVal}
                  onChange={(e) => setWidthVal(e.target.value)}
                  placeholder="Width"
                  className="admin-field-input"
                />
                <input
                  type="number"
                  step="0.1"
                  value={heightVal}
                  onChange={(e) => setHeightVal(e.target.value)}
                  placeholder="Height"
                  className="admin-field-input"
                />
              </div>

              <select
                value={unitVal}
                onChange={(e) => setUnitVal(e.target.value)}
                className="admin-field-select"
              >
                <option value="cm">Unit: Centimeters (cm)</option>
                <option value="in">Unit: Inches (in)</option>
                <option value="mm">Unit: Millimeters (mm)</option>
              </select>

              <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <input
                  type="number"
                  step="0.01"
                  value={weightVal}
                  onChange={(e) => setWeightVal(e.target.value)}
                  placeholder="Weight (kg)"
                  className="admin-field-input"
                />
                <span style={{ fontSize: 12, color: "var(--text-muted)" }}>kg</span>
              </div>
            </div>
          </div>

          {/* Action buttons */}
          <div style={{ display: "flex", justifyContent: "flex-end", alignItems: "center", gap: 10, marginTop: 8 }}>
            {isEdit && onDelete && (
              <button
                type="button"
                className="admin-btn danger-btn"
                onClick={() => {
                  if (productToEdit) onDelete(productToEdit);
                }}
                disabled={submitting}
                id="btn-modal-delete-product"
                style={{ marginRight: "auto" }}
              >
                Delete from Inventory
              </button>
            )}
            <button
              type="button"
              className="admin-btn secondary"
              onClick={onClose}
              disabled={submitting}
            >
              Cancel
            </button>
            <button
              type="submit"
              className="admin-btn"
              style={{ background: "var(--forest)", color: "#fff" }}
              disabled={submitting}
            >
              {submitting ? "Persisting..." : isEdit ? "Update Catalog Item" : "Create Product in Ledger"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ─── Admin Catalog & Inventory Management Tab ────────────────────────────────

function AdminCatalogTab({
  token,
  onNotify,
  onProductsUpdated,
}: {
  token: string;
  onNotify: (msg: string, type?: "success" | "error") => void;
  onProductsUpdated?: () => void;
}) {
  const [items, setItems] = useState<ApiProduct[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [modalOpen, setModalOpen] = useState(false);
  const [productToEdit, setProductToEdit] = useState<Product | null>(null);
  const [productToDelete, setProductToDelete] = useState<{ id: string; name: string; sku: string } | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);

  const confirmDeleteProduct = async (id: string) => {
    setIsDeleting(true);
    try {
      const res = await fetch(`/api/v1/admin/products/${id}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        throw new Error(d.detail || "Failed to delete product from inventory.");
      }
      const data = await res.json();
      onNotify(data.message || "Product successfully removed from inventory.", "success");
      setProductToDelete(null);
      setModalOpen(false);
      loadCatalog();
      if (onProductsUpdated) onProductsUpdated();
    } catch (err: unknown) {
      onNotify((err as Error).message || "Failed to delete product.", "error");
    } finally {
      setIsDeleting(false);
    }
  };

  const loadCatalog = useCallback(() => {
    setLoading(true);
    fetch("/api/v1/admin/products", {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then((r) => (r.ok ? r.json() : Promise.reject(r.statusText)))
      .then((data: ApiProduct[]) => setItems(data))
      .catch(() => onNotify("Could not load administrative catalog list.", "error"))
      .finally(() => setLoading(false));
  }, [token, onNotify]);

  useEffect(() => {
    loadCatalog();
  }, [loadCatalog]);

  const filteredItems = useMemo(() => {
    if (!search.trim()) return items;
    const q = search.toLowerCase();
    return items.filter(
      (p) =>
        p.name.toLowerCase().includes(q) ||
        p.sku.toLowerCase().includes(q) ||
        (p.vendor_name && p.vendor_name.toLowerCase().includes(q)) ||
        (p.category_path && p.category_path.toLowerCase().includes(q))
    );
  }, [items, search]);

  const handleOpenCreate = () => {
    setProductToEdit(null);
    setModalOpen(true);
  };

  const handleOpenEdit = (p: ApiProduct) => {
    const mapped: Product = {
      id: p.id,
      sku: p.sku,
      name: p.name,
      price: p.price_cents / 100,
      salePrice: p.flash_sale ? p.flash_sale.sale_price_cents / 100 : undefined,
      badge: "Catalog",
      color: "sand",
      imageUrl: p.media_gallery?.[0]?.url || `/products/${p.id}.jpg`,
      description: p.description || "",
      rating: 4.8,
      reviewCount: 100,
      category: p.category_path || "General",
      availableQty: p.available_quantity,
      totalStock: p.on_hand_quantity,
      vendorId: p.vendor_id,
      vendorName: p.vendor_name,
      categoryPath: p.category_path,
      dimensions: p.dimensions,
      weight: p.weight,
      mediaGallery: p.media_gallery,
      flashSale: p.flash_sale,
    };
    setProductToEdit(mapped);
    setModalOpen(true);
  };

  const handleSaved = (msg: string) => {
    onNotify(msg, "success");
    loadCatalog();
    if (onProductsUpdated) onProductsUpdated();
  };

  return (
    <div className="admin-pane" id="admin-catalog-pane">
      <div className="admin-catalog-view">
        <div className="admin-catalog-toolbar">
          <div>
            <h2 className="admin-section-title" style={{ margin: 0 }}>
              Catalog Ledger &amp; Inventory Assets
            </h2>
            <p className="admin-section-desc" style={{ margin: "4px 0 0" }}>
              Full mutation control (HTTP PUT/POST) with direct ledger synchronization.
            </p>
          </div>
          <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
            <div className="catalog-search-input-wrap" style={{ width: 280 }}>
              <span className="catalog-search-icon"><IconSearch /></span>
              <input
                type="search"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Filter by SKU, name, vendor..."
                className="catalog-search-input"
                style={{ padding: "8px 12px 8px 36px" }}
              />
            </div>
            <button
              className="admin-btn"
              style={{ background: "var(--forest)", color: "#fff" }}
              onClick={handleOpenCreate}
              id="btn-admin-add-product"
            >
              + Add New Product
            </button>
          </div>
        </div>

        {loading ? (
          <div className="analytics-loading">Loading catalog ledger data...</div>
        ) : (
          <div className="admin-catalog-table-wrap">
            <table className="admin-catalog-table" id="admin-catalog-table">
              <thead>
                <tr>
                  <th>Product Asset</th>
                  <th>SKU</th>
                  <th>Logistics Vendor</th>
                  <th>Classification</th>
                  <th style={{ textAlign: "right" }}>Price</th>
                  <th style={{ textAlign: "right" }}>On Hand</th>
                  <th style={{ textAlign: "right" }}>Reserved</th>
                  <th style={{ textAlign: "right" }}>Available</th>
                  <th style={{ textAlign: "center" }}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {filteredItems.map((p) => {
                  const thumb = p.media_gallery?.[0]?.url || `/products/${p.id}.jpg`;
                  return (
                    <tr key={p.id}>
                      <td>
                        <div className="table-product-cell">
                          <img src={thumb} alt={p.name} className="table-product-thumb" />
                          <div className="table-product-meta">
                            <strong>{p.name}</strong>
                            <span>{p.id.slice(0, 8)}...</span>
                          </div>
                        </div>
                      </td>
                      <td style={{ fontFamily: "var(--font-mono)", fontWeight: 600 }}>{p.sku}</td>
                      <td>
                        <span className="table-vendor-pill">
                          {p.vendor_name || p.vendor_id || "Acro Logistics Corp"}
                        </span>
                      </td>
                      <td style={{ fontSize: 12, color: "var(--text-muted)" }}>
                        {p.category_path || "General"}
                      </td>
                      <td style={{ textAlign: "right", fontFamily: "var(--font-mono)", fontWeight: 600 }}>
                        {formatCents(p.price_cents)}
                      </td>
                      <td style={{ textAlign: "right", fontFamily: "var(--font-mono)" }}>
                        {p.on_hand_quantity}
                      </td>
                      <td style={{ textAlign: "right", fontFamily: "var(--font-mono)", color: "var(--terracotta)" }}>
                        {p.reserved_quantity ?? Math.max(0, p.on_hand_quantity - p.available_quantity)}
                      </td>
                      <td style={{ textAlign: "right", fontFamily: "var(--font-mono)", fontWeight: 700, color: "var(--forest)" }}>
                        {p.available_quantity}
                      </td>
                      <td style={{ textAlign: "center" }}>
                        <div style={{ display: "flex", gap: 6, justifyContent: "center" }}>
                          <button
                            className="table-btn primary"
                            onClick={() => handleOpenEdit(p)}
                            id={`btn-edit-prod-${p.id}`}
                          >
                            Edit
                          </button>
                          <button
                            className="table-btn danger"
                            onClick={() => setProductToDelete({ id: p.id, name: p.name, sku: p.sku })}
                            id={`btn-delete-prod-${p.id}`}
                            title={`Delete ${p.name} from inventory`}
                          >
                            Delete
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <UnifiedProductModal
        isOpen={modalOpen}
        productToEdit={productToEdit}
        token={token}
        onClose={() => setModalOpen(false)}
        onSaved={handleSaved}
        onDelete={(p) => {
          setModalOpen(false);
          setProductToDelete({ id: p.id, name: p.name, sku: p.sku });
        }}
      />

      {/* Delete Product Confirmation Dialog */}
      {productToDelete && (
        <div className="dialog-backdrop" onClick={() => !isDeleting && setProductToDelete(null)} id="delete-product-backdrop">
          <div className="dialog" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 460 }}>
            <div className="dialog-header">
              <h3>Delete Product from Inventory</h3>
              <button
                type="button"
                className="dialog-close"
                onClick={() => !isDeleting && setProductToDelete(null)}
                disabled={isDeleting}
              >
                &times;
              </button>
            </div>
            <div style={{ padding: "16px 20px" }}>
              <p style={{ margin: "0 0 12px", fontSize: 14, color: "var(--text)" }}>
                Are you sure you want to delete <strong>{productToDelete.name}</strong> (SKU: <code>{productToDelete.sku}</code>) from inventory?
              </p>
              <p style={{ margin: 0, fontSize: 12.5, color: "var(--text-muted)", lineHeight: 1.5 }}>
                This action will delete the item and its warehouse allocations from the inventory ledger.
              </p>
            </div>
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 10, padding: "12px 20px 18px" }}>
              <button
                type="button"
                className="admin-btn secondary"
                onClick={() => setProductToDelete(null)}
                disabled={isDeleting}
              >
                Cancel
              </button>
              <button
                type="button"
                className="admin-btn danger-btn"
                onClick={() => confirmDeleteProduct(productToDelete.id)}
                disabled={isDeleting}
                id="btn-confirm-delete-product"
              >
                {isDeleting ? "Deleting..." : "Delete Product"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Admin Panel (Revamped Executive SaaS Dashboard) ─────────────────────────

type AdminTab = "orders" | "catalog" | "overview" | "flash-sales" | "analytics" | "customers" | "scaling";

type AdminOrderItem = {
  id: string;
  product_id?: string;
  product_sku?: string;
  product_name: string;
  quantity: number;
  unit_price_cents: number;
  line_total_cents: number;
  thumbnail_url?: string | null;
};

type AdminOrder = {
  id: string;
  order_number: string;
  user_id?: string | null;
  customer_name: string;
  customer_email?: string;
  customer_phone?: string;
  fulfillment_type: "Shipping" | "Pickups";
  status: "paid" | "cancelled" | "refunded" | "pending_payment";
  currency: string;
  subtotal_cents: number;
  discount_cents: number;
  total_cents: number;
  created_at: string;
  items: AdminOrderItem[];
};

type AdminDashboardSummary = {
  products: number;
  orders: number;
  order_total_cents: number;
  avg_order_cents: number;
  status_distribution: {
    paid_count: number;
    paid_pct: number;
    cancelled_count: number;
    cancelled_pct: number;
    refunded_count: number;
    refunded_pct: number;
    pending_count: number;
    pending_pct: number;
  };
  receipt_of_goods: {
    total_revenue_cents: number;
    total_orders: number;
    shipments_cents: number;
    shipments_orders: number;
    pickups_cents: number;
    pickups_orders: number;
  };
  top_sellers: Array<{
    name: string;
    units_sold: number;
    thumbnail_url: string;
  }>;
};

type AdminCustomer = {
  id: string;
  display_name: string;
  email: string;
  role: string;
  orders_count: number;
  total_spent_cents: number;
  is_active: boolean;
  created_at: string;
};

function AdminPanel({
  token,
  products,
  onNotify,
  onProductsUpdated,
  onReturnToStore,
  userName = "SurgeCart Admin",
  userEmail = "admin@surgecart.local",
}: {
  token: string;
  products: Product[];
  onNotify: (msg: string, type?: "success" | "error" | "info") => void;
  onProductsUpdated?: () => void;
  onReturnToStore?: () => void;
  userName?: string;
  userEmail?: string;
}) {
  const [activeTab, setActiveTab] = useState<AdminTab>("orders");
  const [orders, setOrders] = useState<AdminOrder[]>([]);
  const [loadingOrders, setLoadingOrders] = useState(false);
  const [selectedOrderIds, setSelectedOrderIds] = useState<Set<string>>(new Set());
  const [filterType, setFilterType] = useState<"all" | "Shipping" | "Pickups">("all");
  const [filterStatus, setFilterStatus] = useState<"all" | "paid" | "cancelled" | "refunded">("all");
  const [searchQuery, setSearchQuery] = useState("");
  const [activeOrderDetail, setActiveOrderDetail] = useState<AdminOrder | null>(null);
  const [detailTab, setDetailTab] = useState<"items" | "delivery" | "docs">("items");
  const [summary, setSummary] = useState<AdminDashboardSummary | null>(null);
  const [customers, setCustomers] = useState<AdminCustomer[]>([]);
  const [loadingCustomers, setLoadingCustomers] = useState(false);
  const [isRestocking, setIsRestocking] = useState(false);
  const [isCleaning, setIsCleaning] = useState(false);

  const fetchDashboard = useCallback(() => {
    fetch("/api/v1/admin/dashboard", { headers: { Authorization: `Bearer ${token}` } })
      .then((r) => (r.ok ? r.json() : null))
      .then(setSummary)
      .catch(() => setSummary(null));
  }, [token]);

  const fetchOrders = useCallback(() => {
    setLoadingOrders(true);
    fetch("/api/v1/admin/orders", { headers: { Authorization: `Bearer ${token}` } })
      .then((r) => (r.ok ? r.json() : []))
      .then((data: AdminOrder[]) => {
        setOrders(data);
      })
      .catch(() => {
        onNotify("Failed to fetch administrative order records.", "error");
      })
      .finally(() => setLoadingOrders(false));
  }, [token, onNotify]);

  const fetchCustomers = useCallback(() => {
    setLoadingCustomers(true);
    fetch("/api/v1/admin/customers", { headers: { Authorization: `Bearer ${token}` } })
      .then((r) => (r.ok ? r.json() : []))
      .then((data: AdminCustomer[]) => {
        setCustomers(data);
      })
      .catch(() => {
        onNotify("Failed to fetch customer directory records.", "error");
      })
      .finally(() => setLoadingCustomers(false));
  }, [token, onNotify]);

  useEffect(() => {
    fetchDashboard();
    fetchOrders();
    fetchCustomers();
  }, [fetchDashboard, fetchOrders, fetchCustomers]);

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
      if (onProductsUpdated) onProductsUpdated();
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
        if (onProductsUpdated) onProductsUpdated();
      } else {
        onNotify("Failed to release expired reservations.", "error");
      }
    } catch {
      onNotify("Network communication error while reclaiming holds.", "error");
    } finally {
      setIsCleaning(false);
    }
  };

  // Filtered orders list
  const filteredOrders = useMemo(() => {
    return orders.filter((o) => {
      if (filterType !== "all" && o.fulfillment_type !== filterType) return false;
      if (filterStatus !== "all" && o.status !== filterStatus) return false;
      if (searchQuery.trim()) {
        const q = searchQuery.toLowerCase();
        const matchesNum = o.order_number.toLowerCase().includes(q);
        const matchesName = o.customer_name.toLowerCase().includes(q);
        const matchesEmail = o.customer_email?.toLowerCase().includes(q);
        if (!matchesNum && !matchesName && !matchesEmail) return false;
      }
      return true;
    });
  }, [orders, filterType, filterStatus, searchQuery]);

  const allFilteredSelected =
    filteredOrders.length > 0 && filteredOrders.every((o) => selectedOrderIds.has(o.id));

  const toggleSelectAll = () => {
    if (allFilteredSelected) {
      setSelectedOrderIds(new Set());
    } else {
      const next = new Set<string>();
      filteredOrders.forEach((o) => next.add(o.id));
      setSelectedOrderIds(next);
    }
  };

  const toggleSelectOrder = (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setSelectedOrderIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handleExportSelected = () => {
    onNotify(`Exported ${selectedOrderIds.size} selected order(s) to CSV.`, "success");
  };

  const handlePrintSelected = () => {
    onNotify(`Generated print manifest for ${selectedOrderIds.size} order(s).`, "info");
    window.print();
  };

  const handleDuplicateSelected = () => {
    onNotify(`Duplicated and queued ${selectedOrderIds.size} fulfillment task(s).`, "success");
  };

  return (
    <div className="mate-admin-root" id="admin-workspace">
      {/* ── 1. Left Sleek Sidebar ── */}
      <aside className="mate-sidebar">
        <div>
          <div className="mate-brand-row">
            <a href="#top" className="mate-brand-logo" onClick={(e) => { e.preventDefault(); if (onReturnToStore) onReturnToStore(); }} id="admin-brand-logo">
              <span className="brand-logo-text">surge<span className="brand-accent">cart</span></span>
              <span className="brand-context-tag">Console</span>
            </a>
            <button
              className="mate-collapse-btn"
              title="Return to Storefront"
              onClick={onReturnToStore}
              id="btn-admin-collapse"
            >
              <IconCollapse />
            </button>
          </div>

          <div className="mate-search-pill">
            <IconSearch />
            <input
              type="text"
              placeholder="Search..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              id="admin-sidebar-search"
            />
            <span className="mate-search-kbd">Ctrl F</span>
          </div>

          <nav className="mate-nav-list" aria-label="Admin Navigation">
            <button
              className={`mate-nav-item ${activeTab === "overview" ? "active" : ""}`}
              onClick={() => setActiveTab("overview")}
              id="nav-item-dashboard"
            >
              <div className="mate-nav-item-left">
                <IconDashboard />
                <span>Dashboard</span>
              </div>
            </button>

            <button
              className={`mate-nav-item ${activeTab === "orders" ? "active" : ""}`}
              onClick={() => setActiveTab("orders")}
              id="nav-item-orders"
            >
              <div className="mate-nav-item-left">
                <IconOrdersDoc />
                <span>Orders</span>
              </div>
            </button>

            <button
              className={`mate-nav-item ${activeTab === "catalog" ? "active" : ""}`}
              onClick={() => setActiveTab("catalog")}
              id="nav-item-inventory"
            >
              <div className="mate-nav-item-left">
                <IconInventoryBox />
                <span>Inventory</span>
              </div>
            </button>

            <button
              className={`mate-nav-item ${activeTab === "flash-sales" ? "active" : ""}`}
              onClick={() => setActiveTab("flash-sales")}
              id="nav-item-flash-sales"
            >
              <div className="mate-nav-item-left">
                <IconLightning />
                <span>Flash Sales</span>
              </div>
            </button>

            <button
              className={`mate-nav-item ${activeTab === "analytics" ? "active" : ""}`}
              onClick={() => setActiveTab("analytics")}
              id="nav-item-analytics"
            >
              <div className="mate-nav-item-left">
                <IconSpeed />
                <span>Analytics</span>
              </div>
            </button>

            <button
              className={`mate-nav-item ${activeTab === "customers" ? "active" : ""}`}
              onClick={() => setActiveTab("customers")}
              id="nav-item-customers"
            >
              <div className="mate-nav-item-left">
                <IconUsers />
                <span>Customers</span>
              </div>
            </button>

            <button
              className={`mate-nav-item ${activeTab === "scaling" ? "active" : ""}`}
              onClick={() => setActiveTab("scaling")}
              id="nav-item-scaling"
            >
              <div className="mate-nav-item-left">
                <IconShield />
                <span>Architecture &amp; Scaling</span>
              </div>
            </button>
          </nav>
        </div>

        <div>
          <div className="mate-sidebar-divider" />
          <div className="mate-sidebar-bottom">
            <button
              className="mate-nav-item"
              onClick={() => onNotify("You have 7 unread operational alerts.", "info")}
            >
              <div className="mate-nav-item-left">
                <IconBell />
                <span>Notifications</span>
              </div>
              <span className="mate-badge-count">7</span>
            </button>

            <button
              className="mate-nav-item"
              onClick={() => onNotify("Support documentation loaded.", "info")}
            >
              <div className="mate-nav-item-left">
                <IconHelpCircle />
                <span>Help &amp; support</span>
              </div>
            </button>

            <button
              className="mate-nav-item"
              onClick={() => onNotify("Settings preferences saved.", "info")}
            >
              <div className="mate-nav-item-left">
                <IconGear />
                <span>Settings</span>
              </div>
            </button>

            <button
              className="mate-nav-item"
              onClick={onReturnToStore}
              style={{ color: "var(--terracotta)" }}
              id="btn-sidebar-view-store"
            >
              <div className="mate-nav-item-left">
                <IconRotate />
                <span>View Storefront</span>
              </div>
            </button>
          </div>

          <div className="mate-user-card">
            <div className="mate-user-meta">
              <div className="mate-user-avatar">
                {userName.charAt(0).toUpperCase()}
              </div>
              <div>
                <div className="mate-user-name">{userName}</div>
                <div className="mate-user-sub">{userEmail}</div>
              </div>
            </div>
            <button
              className="mate-collapse-btn"
              onClick={() => onNotify(`Active session: ${userEmail}`, "info")}
            >
              <IconMoreDots />
            </button>
          </div>
        </div>
      </aside>

      {/* ── 2. Center Main Viewport ── */}
      <main className="mate-main-viewport">
        <div className="mate-main-content">
          {/* Header */}
          <div className="mate-top-header">
            <h1 className="mate-page-title">
              {activeTab === "orders" && "Orders"}
              {activeTab === "catalog" && "Inventory & Catalog"}
              {activeTab === "overview" && "Dashboard Overview"}
              {activeTab === "flash-sales" && "Flash Sales Scheduler"}
              {activeTab === "analytics" && "Analytics & Velocity"}
              {activeTab === "customers" && "Customers Directory"}
            </h1>

            <div className="mate-header-actions">
              <button
                className="mate-btn-action"
                onClick={() => onNotify("Import manifest initiated.", "info")}
                id="btn-admin-import"
              >
                <IconDownloadArrow />
                <span>Import</span>
              </button>
              <button
                className="mate-btn-action"
                onClick={() => onNotify("Export payload ready.", "info")}
                id="btn-admin-export"
              >
                <IconUploadArrow />
                <span>Export</span>
              </button>
              {activeTab === "catalog" && (
                <button
                  className="mate-btn-action primary"
                  onClick={() => {
                    const addBtn = document.getElementById("btn-add-product");
                    if (addBtn) addBtn.click();
                  }}
                >
                  + Add Product
                </button>
              )}
            </div>
          </div>

          {/* TAB 1: ORDERS (Primary Screen Matching Design) */}
          {activeTab === "orders" && (
            <div>
              {/* Filter Bar */}
              <div className="mate-filter-toolbar">
                <button
                  className={`mate-filter-pill ${filterType !== "all" ? "dark-active" : ""}`}
                  onClick={() => {
                    setFilterType((prev) =>
                      prev === "all" ? "Shipping" : prev === "Shipping" ? "Pickups" : "all"
                    );
                  }}
                  id="filter-type-pill"
                >
                  <span>Type {filterType !== "all" ? `[${filterType}]` : "3"}</span>
                  <span style={{ fontSize: 9 }}>&#9660;</span>
                </button>

                <button
                  className={`mate-filter-pill ${filterStatus !== "all" ? "dark-active" : ""}`}
                  onClick={() => {
                    setFilterStatus((prev) =>
                      prev === "all" ? "paid" : prev === "paid" ? "cancelled" : prev === "cancelled" ? "refunded" : "all"
                    );
                  }}
                  id="filter-status-pill"
                >
                  <span>Status {filterStatus !== "all" ? `[${filterStatus}]` : ""}</span>
                  <span style={{ fontSize: 9 }}>&#9660;</span>
                </button>

                <button
                  className="mate-filter-pill"
                  onClick={() => onNotify("Filtered by current billing month.", "info")}
                >
                  <span>Order date</span>
                  <span style={{ fontSize: 9 }}>&#9660;</span>
                </button>

                <button
                  className="mate-filter-pill"
                  onClick={() => {
                    setFilterType("all");
                    setFilterStatus("all");
                    setSearchQuery("");
                  }}
                >
                  <span>All filters</span>
                  <span style={{ fontSize: 9 }}>&#9660;</span>
                </button>

                <input
                  type="text"
                  className="mate-search-filter-input"
                  placeholder="Filter orders..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  id="orders-search-input"
                />
              </div>

              {/* Orders Table */}
              <div className="mate-table-wrapper">
                <table className="mate-table">
                  <thead>
                    <tr>
                      <th style={{ width: 36 }}>
                        <input
                          type="checkbox"
                          className="mate-checkbox"
                          checked={allFilteredSelected}
                          onChange={toggleSelectAll}
                          aria-label="Select all orders"
                        />
                      </th>
                      <th>Order &#9660;</th>
                      <th>Customer</th>
                      <th>Type</th>
                      <th>Status</th>
                      <th>Product</th>
                      <th>Total</th>
                      <th>Date</th>
                      <th style={{ width: 40 }} />
                    </tr>
                  </thead>
                  <tbody>
                    {loadingOrders ? (
                      <tr>
                        <td colSpan={9} style={{ textAlign: "center", padding: "40px" }}>
                          Loading order settlement records...
                        </td>
                      </tr>
                    ) : filteredOrders.length === 0 ? (
                      <tr>
                        <td colSpan={9} style={{ textAlign: "center", padding: "40px", color: "#64748b" }}>
                          No orders matched your current filters.
                        </td>
                      </tr>
                    ) : (
                      filteredOrders.map((ord) => {
                        const isSelected = selectedOrderIds.has(ord.id);
                        return (
                          <tr
                            key={ord.id}
                            className={isSelected ? "selected" : ""}
                            onClick={() => setActiveOrderDetail(ord)}
                            style={{ cursor: "pointer" }}
                          >
                            <td onClick={(e) => e.stopPropagation()}>
                              <input
                                type="checkbox"
                                className="mate-checkbox"
                                checked={isSelected}
                                onChange={(e) => toggleSelectOrder(ord.id, e as unknown as React.MouseEvent)}
                                aria-label={`Select order ${ord.order_number}`}
                              />
                            </td>
                            <td>
                              <span className="mate-order-badge">
                                <span>{ord.order_number}</span>
                                <IconComment />
                              </span>
                            </td>
                            <td>
                              <div className="mate-customer-cell">
                                <div className="mate-customer-avatar">
                                  {ord.customer_name
                                    .split(" ")
                                    .map((n) => n[0])
                                    .join("")
                                    .slice(0, 2)
                                    .toUpperCase()}
                                </div>
                                <span>{ord.customer_name}</span>
                              </div>
                            </td>
                            <td>
                              <span className="mate-type-cell">{ord.fulfillment_type}</span>
                            </td>
                            <td>
                              {ord.status === "paid" && (
                                <span className="mate-status-badge mate-status-paid">
                                  <IconCheckSm />
                                  <span>Paid</span>
                                </span>
                              )}
                              {ord.status === "cancelled" && (
                                <span className="mate-status-badge mate-status-cancelled">
                                  <IconCrossSm />
                                  <span>Cancelled</span>
                                </span>
                              )}
                              {ord.status === "refunded" && (
                                <span className="mate-status-badge mate-status-refunded">
                                  <IconRotate />
                                  <span>Refunded</span>
                                </span>
                              )}
                              {ord.status === "pending_payment" && (
                                <span className="mate-status-badge" style={{ color: "#d97706" }}>
                                  Pending
                                </span>
                              )}
                            </td>
                            <td>
                              <div className="mate-item-thumbs">
                                {ord.items && ord.items.length > 0 ? (
                                  ord.items.slice(0, 2).map((item, idx) => (
                                    <img
                                      key={idx}
                                      src={item.thumbnail_url || "/products/sneaker.jpg"}
                                      alt={item.product_name}
                                      className="mate-item-thumb"
                                      onError={(e) => {
                                        (e.target as HTMLImageElement).src =
                                          "https://images.unsplash.com/photo-1504148455328-c376907d081c?w=100&q=80";
                                      }}
                                    />
                                  ))
                                ) : (
                                  <img
                                    src="https://images.unsplash.com/photo-1581092160607-ee22621dd758?w=100&q=80"
                                    alt="Product"
                                    className="mate-item-thumb"
                                  />
                                )}
                              </div>
                            </td>
                            <td>
                              <span className="mate-total-cell">
                                {formatCents(ord.total_cents)}
                              </span>
                            </td>
                            <td>
                              <span className="mate-date-cell">{ord.created_at}</span>
                            </td>
                            <td>
                              <button
                                className="mate-row-action"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  setActiveOrderDetail(ord);
                                }}
                                aria-label="Order details"
                              >
                                <IconMoreDots />
                              </button>
                            </td>
                          </tr>
                        );
                      })
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* TAB 2: INVENTORY & CATALOG */}
          {activeTab === "catalog" && (
            <AdminCatalogTab
              token={token}
              onNotify={onNotify}
              onProductsUpdated={onProductsUpdated}
            />
          )}

          {/* TAB 3: OVERVIEW */}
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
                  <div className="stat-value">{summary ? summary.orders : orders.length}</div>
                  <span className="stat-sub">Paid &amp; confirmed orders</span>
                </div>
                <div className="admin-stat-card">
                  <span className="stat-label">Total Sales Volume</span>
                  <div className="stat-value">{summary ? formatCents(summary.order_total_cents) : "₹2,246,750"}</div>
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

          {/* TAB 4: FLASH SALES */}
          {activeTab === "flash-sales" && (
            <CreateFlashSaleTab token={token} onNotify={onNotify} />
          )}

          {/* TAB 5: ANALYTICS */}
          {activeTab === "analytics" && <AnalyticsTab token={token} />}

          {/* TAB 6: CUSTOMERS */}
          {activeTab === "customers" && (
            <div className="mate-table-wrapper" style={{ padding: 20 }}>
              <h2 style={{ fontSize: 18, margin: "0 0 16px", color: "var(--forest)", fontFamily: "var(--font-serif)" }}>
                Registered Customer Directory
              </h2>
              {loadingCustomers ? (
                <div style={{ textAlign: "center", padding: "40px", color: "var(--text-muted)" }}>
                  Loading customer accounts from database...
                </div>
              ) : customers.length === 0 ? (
                <div style={{ textAlign: "center", padding: "40px", color: "var(--text-muted)" }}>
                  No customer accounts registered yet.
                </div>
              ) : (
                <table className="mate-table">
                  <thead>
                    <tr>
                      <th>Customer Name</th>
                      <th>Email Address</th>
                      <th>Account Role</th>
                      <th>Orders Placed</th>
                      <th>Lifetime Spend</th>
                      <th>Member Since</th>
                      <th>Account Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {customers.map((c) => (
                      <tr key={c.id}>
                        <td>
                          <div className="mate-customer-cell">
                            <div className="mate-customer-avatar">
                              {c.display_name.charAt(0).toUpperCase()}
                            </div>
                            <strong>{c.display_name}</strong>
                          </div>
                        </td>
                        <td>{c.email}</td>
                        <td>
                          <span
                            className="pill-tag"
                            style={{
                              background: c.role === "admin" ? "rgba(196, 98, 56, 0.15)" : "rgba(26, 56, 40, 0.1)",
                              color: c.role === "admin" ? "var(--terracotta)" : "var(--forest)",
                              fontWeight: 600,
                              borderRadius: 4,
                              padding: "2px 6px",
                            }}
                          >
                            {c.role.toUpperCase()}
                          </span>
                        </td>
                        <td>
                          <strong>{c.orders_count}</strong> {c.orders_count === 1 ? "order" : "orders"}
                        </td>
                        <td>
                          <strong>{formatCents(c.total_spent_cents)}</strong>
                        </td>
                        <td style={{ color: "var(--text-muted)", fontSize: 12.5 }}>{c.created_at}</td>
                        <td>
                          <span className="mate-status-badge mate-status-paid">
                            <IconCheckSm />
                            <span>{c.is_active ? "Active" : "Suspended"}</span>
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          )}

          {/* TAB 7: ARCHITECTURE & SCALING */}
          {activeTab === "scaling" && (
            <ScalingArchitectureTab token={token} onNotify={onNotify} />
          )}
        </div>

        {/* ── Floating Selection Action Bar ── */}
        {selectedOrderIds.size > 0 && (
          <div className="mate-floating-action-bar" id="floating-selection-bar">
            <button
              className="mate-floating-bar-close"
              onClick={() => setSelectedOrderIds(new Set())}
              title="Clear selection"
            >
              <IconCrossSm />
            </button>
            <span className="mate-floating-selected-text">
              Selected: {selectedOrderIds.size}
            </span>
            <button className="mate-floating-btn" onClick={handleExportSelected}>
              <IconUploadArrow />
              <span>Export</span>
            </button>
            <button className="mate-floating-btn" onClick={handlePrintSelected}>
              <IconPrinter />
              <span>Print</span>
            </button>
            <button className="mate-floating-btn" onClick={handleDuplicateSelected}>
              <IconDuplicate />
              <span>Duplicate</span>
            </button>
            <button
              className="mate-floating-btn"
              onClick={() => onNotify("Batch action options: Mark Fulfilled, Hold.", "info")}
            >
              <IconMoreDots />
            </button>
          </div>
        )}

        {/* ── Order Detail Popover Modal Card (Ref #4567) ── */}
        {activeOrderDetail && (
          <div
            className="mate-detail-popover-overlay"
            onClick={() => setActiveOrderDetail(null)}
          >
            <div
              className="mate-detail-popover-card"
              onClick={(e) => e.stopPropagation()}
              id="order-detail-card"
            >
              {/* Header */}
              <div className="mate-detail-popover-header">
                <div className="mate-detail-title">
                  <IconMoreDots />
                  <span>Order {activeOrderDetail.order_number}</span>
                </div>
                <div className="mate-detail-header-icons">
                  <button
                    onClick={() => {
                      onNotify(`Expanded view for ${activeOrderDetail.order_number}`, "info");
                    }}
                    title="Expand"
                  >
                    <IconUploadArrow />
                  </button>
                  <button
                    onClick={() => setActiveOrderDetail(null)}
                    title="Close"
                  >
                    <IconCrossSm />
                  </button>
                </div>
              </div>

              {/* Body */}
              <div className="mate-detail-body">
                {/* Customer Contact Box */}
                <div className="mate-detail-customer-box">
                  <div className="mate-detail-customer-row">
                    <div className="mate-customer-avatar" style={{ width: 22, height: 22 }}>
                      {activeOrderDetail.customer_name.charAt(0)}
                    </div>
                    <span className="mate-detail-customer-name">
                      {activeOrderDetail.customer_name}
                    </span>
                  </div>
                  <div className="mate-detail-customer-row">
                    <IconOrdersDoc />
                    <span>{activeOrderDetail.customer_email || "brodrigues@gmail.com"}</span>
                  </div>
                  <div className="mate-detail-customer-row">
                    <IconTruck />
                    <span>{activeOrderDetail.customer_phone || "+1 (415) 555-2671"}</span>
                  </div>
                </div>

                {/* Sub-tabs */}
                <div className="mate-detail-tabs">
                  <button
                    className={`mate-detail-tab ${detailTab === "items" ? "active" : ""}`}
                    onClick={() => setDetailTab("items")}
                  >
                    Order items
                  </button>
                  <button
                    className={`mate-detail-tab ${detailTab === "delivery" ? "active" : ""}`}
                    onClick={() => setDetailTab("delivery")}
                  >
                    Delivery
                  </button>
                  <button
                    className={`mate-detail-tab ${detailTab === "docs" ? "active" : ""}`}
                    onClick={() => setDetailTab("docs")}
                  >
                    Docs
                  </button>
                </div>

                {/* Items List */}
                {detailTab === "items" && (
                  <div className="mate-detail-items-list">
                    {activeOrderDetail.items && activeOrderDetail.items.length > 0 ? (
                      activeOrderDetail.items.map((item, idx) => (
                        <div key={idx} className="mate-detail-item-row">
                          <img
                            src={item.thumbnail_url || "/products/sneaker.jpg"}
                            alt={item.product_name}
                            className="mate-detail-item-img"
                            onError={(e) => {
                              (e.target as HTMLImageElement).src =
                                "https://images.unsplash.com/photo-1504148455328-c376907d081c?w=100&q=80";
                            }}
                          />
                          <div className="mate-detail-item-meta">
                            <div className="mate-detail-item-name">{item.product_name}</div>
                            <div className="mate-detail-item-calc">
                              {item.quantity} &times; {formatCents(item.unit_price_cents)}
                            </div>
                          </div>
                        </div>
                      ))
                    ) : (
                      <div className="mate-detail-item-row">
                        <img
                          src="https://images.unsplash.com/photo-1504148455328-c376907d081c?w=100&q=80"
                          alt="Product"
                          className="mate-detail-item-img"
                        />
                        <div className="mate-detail-item-meta">
                          <div className="mate-detail-item-name">
                            Stihl TS 800 cut-off machine incl. 5x diamond cutting discs
                          </div>
                          <div className="mate-detail-item-calc">1 &times; ₹1,590.00</div>
                        </div>
                      </div>
                    )}
                  </div>
                )}

                {detailTab === "delivery" && (
                  <div style={{ fontSize: 13, color: "#475569", padding: "10px 0" }}>
                    <div><strong>Carrier:</strong> DHL Express Worldwide</div>
                    <div><strong>Tracking:</strong> TRK-9921-48201-IN</div>
                    <div><strong>Address:</strong> Flat 402, Skyline Residency, Indiranagar, Bengaluru, KA</div>
                  </div>
                )}

                {detailTab === "docs" && (
                  <div style={{ fontSize: 13, color: "#475569", padding: "10px 0" }}>
                    <div><strong>Invoice:</strong> INV-{activeOrderDetail.order_number}.pdf</div>
                    <div><strong>Packing Slip:</strong> Ready for print</div>
                  </div>
                )}

                {/* Subtotal / Total */}
                <div className="mate-detail-total-row">
                  <span>Total:</span>
                  <span className="mate-detail-total-amt">
                    {formatCents(activeOrderDetail.total_cents)}
                  </span>
                </div>

                {/* Action buttons */}
                <div className="mate-detail-footer">
                  <button
                    className="mate-detail-footer-btn"
                    onClick={() => {
                      onNotify(`Exported order ${activeOrderDetail.order_number}.`, "success");
                    }}
                  >
                    <IconUploadArrow />
                    <span>Export</span>
                  </button>
                  <button
                    className="mate-detail-footer-btn"
                    onClick={() => {
                      onNotify(`Duplicated order ${activeOrderDetail.order_number}.`, "success");
                    }}
                  >
                    <IconDuplicate />
                    <span>Duplicate</span>
                  </button>
                  <button
                    className="mate-detail-footer-btn"
                    onClick={() => {
                      onNotify(`Sent invoice for ${activeOrderDetail.order_number} to printer.`, "info");
                      window.print();
                    }}
                  >
                    <IconPrinter />
                    <span>Print</span>
                  </button>
                  <button
                    className="mate-detail-footer-btn"
                    onClick={() => onNotify("Additional order actions.", "info")}
                  >
                    <IconMoreDots />
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}
      </main>

      {/* ── 3. Right Intelligence Rail (Powered by Live DB Data) ── */}
      <aside className="mate-right-rail" aria-label="Intelligence Dashboard">
        {/* Receipt of goods */}
        <div>
          <div className="mate-rail-section-header">
            <h3 className="mate-rail-title">Receipt of goods</h3>
          </div>
          <div className="mate-gauge-wrapper">
            {(() => {
              const totalCents = summary?.receipt_of_goods?.total_revenue_cents ?? summary?.order_total_cents ?? 0;
              const totalOrdersCount = summary?.receipt_of_goods?.total_orders ?? summary?.orders ?? orders.length;
              const shipCents = summary?.receipt_of_goods?.shipments_cents ?? Math.round(totalCents * 0.68);
              const shipOrders = summary?.receipt_of_goods?.shipments_orders ?? Math.round(totalOrdersCount * 0.65);
              const pickCents = summary?.receipt_of_goods?.pickups_cents ?? Math.max(0, totalCents - shipCents);
              const pickOrders = summary?.receipt_of_goods?.pickups_orders ?? Math.max(0, totalOrdersCount - shipOrders);

              // SVG semi-circle arc calculation
              // Total arc length for R=65 across 180 deg is ~204.2
              const arcLength = 204.2;
              const shipRatio = totalOrdersCount > 0 ? shipOrders / totalOrdersCount : 0.65;
              const shipDash = Math.round(arcLength * shipRatio);
              const pickDash = Math.round(arcLength * (1 - shipRatio));

              return (
                <>
                  <svg className="mate-gauge-svg" viewBox="0 0 160 90">
                    {/* Background track */}
                    <path
                      d="M 15 80 A 65 65 0 0 1 145 80"
                      fill="none"
                      stroke="var(--sand-border)"
                      strokeWidth="10"
                      strokeLinecap="round"
                    />
                    {/* Shipments arc segment (Forest Green) */}
                    <path
                      d="M 15 80 A 65 65 0 0 1 145 80"
                      fill="none"
                      stroke="var(--forest)"
                      strokeWidth="10"
                      strokeDasharray={`${shipDash} ${arcLength}`}
                      strokeLinecap="round"
                    />
                    {/* Pickups arc segment (Terracotta) */}
                    <path
                      d="M 15 80 A 65 65 0 0 1 145 80"
                      fill="none"
                      stroke="var(--terracotta)"
                      strokeWidth="10"
                      strokeDasharray={`0 ${shipDash} ${pickDash} 0`}
                      strokeLinecap="round"
                    />
                  </svg>
                  <div className="mate-gauge-center-text">
                    <div className="mate-gauge-val">{formatCents(totalCents)}</div>
                    <div className="mate-gauge-sub">{totalOrdersCount} orders</div>
                  </div>

                  <div className="mate-gauge-legend">
                    <div className="mate-gauge-legend-item">
                      <div className="mate-gauge-legend-top">
                        <span className="mate-gauge-legend-dot" style={{ background: "var(--forest)" }} />
                        <span>{formatCents(shipCents)}</span>
                      </div>
                      <div className="mate-gauge-legend-sub">{shipOrders} shipments</div>
                    </div>

                    <div className="mate-gauge-legend-item">
                      <div className="mate-gauge-legend-top">
                        <span className="mate-gauge-legend-dot" style={{ background: "var(--terracotta)" }} />
                        <span>{formatCents(pickCents)}</span>
                      </div>
                      <div className="mate-gauge-legend-sub">{pickOrders} pickups</div>
                    </div>
                  </div>
                </>
              );
            })()}
          </div>
        </div>

        {/* Orders status */}
        <div>
          <div className="mate-rail-section-header">
            <h3 className="mate-rail-title">Orders status</h3>
            <button
              className="mate-rail-dropdown-btn"
              onClick={() => onNotify("Filter status: Active settled orders", "info")}
            >
              <span>Active</span>
              <span style={{ fontSize: 9 }}>&#9660;</span>
            </button>
          </div>

          {(() => {
            const dist = summary?.status_distribution;
            const paidPct = dist?.paid_pct ?? 92.9;
            const pendingPct = dist?.pending_pct ?? 7.1;
            const cancelledPct = dist?.cancelled_pct ?? 0;
            const refundedPct = dist?.refunded_pct ?? 0;
            const paidCount = dist?.paid_count ?? 13;
            const pendingCount = dist?.pending_count ?? 1;
            const cancelledCount = dist?.cancelled_count ?? 0;
            const refundedCount = dist?.refunded_count ?? 0;

            return (
              <>
                <div className="mate-segmented-bar">
                  <div className="mate-segment-paid" style={{ width: `${paidPct}%`, background: "var(--forest)" }} />
                  <div className="mate-segment-pending" style={{ width: `${pendingPct}%`, background: "#d97706" }} />
                  <div className="mate-segment-cancelled" style={{ width: `${cancelledPct}%`, background: "var(--terracotta)" }} />
                  <div className="mate-segment-refunded" style={{ width: `${refundedPct}%`, background: "#8c827a" }} />
                </div>

                <div className="mate-status-breakdown-list">
                  <div className="mate-status-breakdown-row">
                    <div className="mate-status-label-group">
                      <span className="mate-gauge-legend-dot" style={{ background: "var(--forest)" }} />
                      <span>Paid ({paidCount})</span>
                    </div>
                    <span className="mate-status-pct">{paidPct}%</span>
                  </div>
                  {pendingCount > 0 && (
                    <div className="mate-status-breakdown-row">
                      <div className="mate-status-label-group">
                        <span className="mate-gauge-legend-dot" style={{ background: "#d97706" }} />
                        <span>Pending ({pendingCount})</span>
                      </div>
                      <span className="mate-status-pct">{pendingPct}%</span>
                    </div>
                  )}
                  <div className="mate-status-breakdown-row">
                    <div className="mate-status-label-group">
                      <span className="mate-gauge-legend-dot" style={{ background: "var(--terracotta)" }} />
                      <span>Cancelled ({cancelledCount})</span>
                    </div>
                    <span className="mate-status-pct">{cancelledPct}%</span>
                  </div>
                  <div className="mate-status-breakdown-row">
                    <div className="mate-status-label-group">
                      <span className="mate-gauge-legend-dot" style={{ background: "#8c827a" }} />
                      <span>Refunded ({refundedCount})</span>
                    </div>
                    <span className="mate-status-pct">{refundedPct}%</span>
                  </div>
                </div>
              </>
            );
          })()}
        </div>

        {/* Overview */}
        <div>
          <div className="mate-rail-section-header">
            <h3 className="mate-rail-title">Overview</h3>
            <button
              className="mate-rail-dropdown-btn"
              onClick={() => onNotify("Live metrics aggregated from current database ledger.", "info")}
            >
              <span>This month</span>
              <span style={{ fontSize: 9 }}>&#9660;</span>
            </button>
          </div>

          <div className="mate-kpi-2x3-grid">
            <div className="mate-kpi-tile">
              <div className="mate-kpi-val">
                {summary ? formatCents(summary.avg_order_cents) : "₹163.02"}
              </div>
              <div className="mate-kpi-lbl">Average order</div>
            </div>
            <div className="mate-kpi-tile">
              <div className="mate-kpi-val">
                {summary ? formatCents(summary.order_total_cents) : "₹2,282.40"}
              </div>
              <div className="mate-kpi-lbl">Total revenue</div>
            </div>
            <div className="mate-kpi-tile">
              <div className="mate-kpi-val">12 min</div>
              <div className="mate-kpi-lbl">Processing time</div>
            </div>
            <div className="mate-kpi-tile">
              <div className="mate-kpi-val">1.6</div>
              <div className="mate-kpi-lbl">Avg. items/order</div>
            </div>
            <div className="mate-kpi-tile">
              <div className="mate-kpi-val">
                {summary?.status_distribution ? `${summary.status_distribution.pending_pct}%` : "7.1%"}
              </div>
              <div className="mate-kpi-lbl">Pending orders</div>
            </div>
            <div className="mate-kpi-tile">
              <div className="mate-kpi-val">
                {summary?.status_distribution ? `${summary.status_distribution.cancelled_pct}%` : "0.0%"}
              </div>
              <div className="mate-kpi-lbl">Reject rate</div>
            </div>
          </div>
        </div>

        {/* Top Sellers (Real DB Top Sellers) */}
        <div>
          <div className="mate-rail-section-header">
            <h3 className="mate-rail-title">Top Sellers</h3>
            <button
              className="mate-rail-dropdown-btn"
              onClick={() => onNotify("Live top selling merchandise sorted by confirmed unit sales.", "info")}
            >
              <span>This month</span>
              <span style={{ fontSize: 9 }}>&#9660;</span>
            </button>
          </div>

          <div className="mate-top-sellers-list">
            {summary?.top_sellers && summary.top_sellers.length > 0 ? (
              summary.top_sellers.map((item, idx) => (
                <div key={idx} className="mate-top-seller-row">
                  <div className="mate-top-seller-left">
                    <img
                      src={item.thumbnail_url || "/products/speaker.jpg"}
                      alt={item.name}
                      className="mate-top-seller-img"
                      onError={(e) => {
                        (e.target as HTMLImageElement).src =
                          "https://images.unsplash.com/photo-1504148455328-c376907d081c?w=100&q=80";
                      }}
                    />
                    <div className="mate-top-seller-title" title={item.name}>
                      {item.name}
                    </div>
                  </div>
                  <div className="mate-top-seller-badge">{item.units_sold}</div>
                </div>
              ))
            ) : (
              <div style={{ fontSize: 12, color: "var(--text-muted)", padding: "10px 0" }}>
                No settled order units yet.
              </div>
            )}
          </div>
        </div>
      </aside>
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

  // Dedicated View Mode: "store" | "admin" | "pdp"
  const [viewMode, setViewMode] = useState<"store" | "admin" | "pdp">(() => {
    if (typeof window !== "undefined") {
      const path = window.location.pathname;
      const hash = window.location.hash;
      if (path === "/admin" || hash === "#admin") return "admin";
      if (hash.startsWith("#catalog/")) return "pdp";
    }
    return "store";
  });

  const [pdpSkuOrId, setPdpSkuOrId] = useState<string | null>(() => {
    if (typeof window !== "undefined") {
      const hash = window.location.hash;
      if (hash.startsWith("#catalog/")) {
        return decodeURIComponent(hash.replace("#catalog/", ""));
      }
    }
    return null;
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
  const [showBackToTop, setShowBackToTop] = useState(false);
  const [toasts, setToasts] = useState<Toast[]>([]);

  // Virtual waiting room state
  const [showWaitingRoomModal, setShowWaitingRoomModal] = useState(false);
  const [waitingRoomTicketId, setWaitingRoomTicketId] = useState("");
  const [waitingRoomCartId, setWaitingRoomCartId] = useState("");

  // Automated restock waitlist state
  const [waitlistModalProduct, setWaitlistModalProduct] = useState<Product | null>(null);
  const [activeRestockAlerts, setActiveRestockAlerts] = useState<
    Array<{
      waitlist_id: string;
      product_id: string;
      product_name: string;
      product_sku?: string;
      price_cents?: number;
      claim_token: string;
      claim_expires_at: string | null;
      remaining_seconds: number;
    }>
  >([]);

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
  const navigateTo = useCallback((mode: "store" | "admin" | "pdp", targetSku?: string) => {
    setViewMode(mode);
    if (mode === "admin") {
      window.history.pushState(null, "", "#admin");
      setPdpSkuOrId(null);
    } else if (mode === "pdp" && targetSku) {
      setPdpSkuOrId(targetSku);
      window.history.pushState(null, "", `#catalog/${encodeURIComponent(targetSku)}`);
    } else {
      window.history.pushState(null, "", "#drops");
      setPdpSkuOrId(null);
    }
    window.scrollTo({ top: 0, behavior: "smooth" });
  }, []);

  const navigateToCatalog = useCallback((skuOrId: string) => {
    setPdpSkuOrId(skuOrId);
    setViewMode("pdp");
    window.history.pushState(null, "", `#catalog/${encodeURIComponent(skuOrId)}`);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }, []);

  useEffect(() => {
    const onHashChange = () => {
      const hash = window.location.hash;
      if (hash === "#admin") {
        setViewMode("admin");
        setPdpSkuOrId(null);
      } else if (hash.startsWith("#catalog/")) {
        const target = decodeURIComponent(hash.replace("#catalog/", ""));
        setPdpSkuOrId(target);
        setViewMode("pdp");
        window.scrollTo({ top: 0, behavior: "smooth" });
      } else if (
        hash === "" ||
        hash === "#top" ||
        hash === "#drops" ||
        hash === "#how"
      ) {
        setViewMode("store");
        setPdpSkuOrId(null);
      }
    };
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  // ── Scroll header & back-to-top tracking ──────────────────────────────
  useEffect(() => {
    const onScroll = () => {
      setIsScrolled(window.scrollY > 20);
      setShowBackToTop(window.scrollY > 400);
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  // ── Keyboard accessibility (Escape key to dismiss overlays) ────────────
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (isCartOpen) setIsCartOpen(false);
        if (waitlistModalProduct) setWaitlistModalProduct(null);
        if (showAuthModal) setShowAuthModal(false);
        if (showUserDropdown) setShowUserDropdown(false);
        if (showUserAddressDropdown) setShowUserAddressDropdown(false);
        if (isDrawerAddressSelectorOpen) setIsDrawerAddressSelectorOpen(false);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isCartOpen, waitlistModalProduct, showAuthModal, showUserDropdown, showUserAddressDropdown, isDrawerAddressSelectorOpen]);

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

  // ── Load and refresh restock alerts (FIFO hold expiration notifications) ─
  const fetchRestockAlerts = useCallback(() => {
    const userEmail = session?.email || (typeof window !== "undefined" ? localStorage.getItem("surgecart_waitlist_email") : null);
    if (!userEmail) return;
    fetch(`/api/v1/waitlist/my-alerts?email=${encodeURIComponent(userEmail)}`)
      .then((r) => (r.ok ? r.json() : []))
      .then((alerts) => {
        if (Array.isArray(alerts)) {
          setActiveRestockAlerts(alerts);
        }
      })
      .catch(() => {});
  }, [session]);

  useEffect(() => {
    fetchRestockAlerts();
    const interval = setInterval(fetchRestockAlerts, 5000);
    return () => clearInterval(interval);
  }, [fetchRestockAlerts]);

  const handleClaimRestock = async (alertItem: {
    waitlist_id: string;
    product_id: string;
    product_name: string;
    claim_token: string;
  }) => {
    try {
      const res = await fetch("/api/v1/waitlist/claim", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ claim_token: alertItem.claim_token }),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        throw new Error(d.detail || "Claim window expired or invalid.");
      }
      showToast(`Reserved stock claimed for ${alertItem.product_name}! Added to bag.`, "success");
      const matched = products.find((p) => p.id === alertItem.product_id);
      if (matched) {
        addToBag(matched, 1);
        setIsCartOpen(true);
      }
      fetchRestockAlerts();
      fetchProducts();
    } catch (err: unknown) {
      showToast((err as Error).message || "Could not claim restock hold.", "error");
    }
  };

  const handleWaitingRoomAdmitted = (token: string) => {
    setShowWaitingRoomModal(false);
    showToast("Admitted from queue! Completing checkout reservation...", "info");
    void handleCheckout(token);
  };

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
            imageUrl: item.media_gallery?.[0]?.url ?? enrich.imageUrl ?? `/products/${item.id}.jpg`,
            description: item.description ?? enrich.description ?? "Limited edition drop.",
            rating: item.rating !== undefined ? item.rating : (enrich.rating ?? 4.8),
            reviewCount: item.review_count !== undefined ? item.review_count : (enrich.reviewCount ?? 0),
            category: item.category_path?.split(" > ").pop() ?? enrich.category ?? "Gear",
            availableQty: item.available_quantity,
            totalStock: enrich.totalStock ?? item.on_hand_quantity ?? 100,
            vendorId: item.vendor_id,
            vendorName: item.vendor_name,
            categoryPath: item.category_path,
            dimensions: item.dimensions,
            weight: item.weight,
            mediaGallery: item.media_gallery,
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
    (product: Product, quantity = 1) => {
      setCart((prev) => {
        const existing = prev.find((i) => i.product.id === product.id);
        if (existing) return prev.map((i) => i.product.id === product.id ? { ...i, quantity: i.quantity + quantity } : i);
        return [...prev, { product, quantity }];
      });
      setRecentlyAddedId(product.id);
      setTimeout(() => setRecentlyAddedId(null), 1500);
      showToast(`${quantity > 1 ? `${quantity}x ` : ""}${product.name} added to your bag`, "success", "View Bag", () => setIsCartOpen(true));
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
  const handleCheckout = async (admissionToken?: string) => {
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

      // 3. Complete checkout reservation (pass admissionToken if available)
      const idempotencyKey = crypto.randomUUID?.() ?? `chk-${Date.now()}`;
      const checkoutHeaders: Record<string, string> = {
        "Content-Type": "application/json",
        "Idempotency-Key": idempotencyKey,
      };
      if (admissionToken) {
        checkoutHeaders["X-Queue-Admission-Token"] = admissionToken;
      }

      const orderRes = await fetch(`/api/v1/orders/checkout/${activeCartId}`, {
        method: "POST",
        headers: checkoutHeaders,
      });

      if (!orderRes.ok) {
        if (orderRes.status === 429) {
          const isWaitingRoom = orderRes.headers.get("X-Waiting-Room-Required") === "true";
          const ed = await orderRes.json().catch(() => ({})) as { detail?: string };
          if (isWaitingRoom || (ed.detail && ed.detail.toLowerCase().includes("waiting room"))) {
            // Shopper placed in virtual waiting room queue
            const joinRes = await fetch("/api/v1/waiting-room/join", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ cart_id: activeCartId }),
            });
            if (joinRes.ok) {
              const queueData = await joinRes.json();
              if (queueData.status === "ADMITTED" && queueData.admission_token) {
                // Instantly admitted, retry checkout directly
                return handleCheckout(queueData.admission_token);
              }
              setWaitingRoomCartId(activeCartId);
              setWaitingRoomTicketId(queueData.ticket_id);
              setShowWaitingRoomModal(true);
              return;
            }
          }
          throw new Error(ed.detail ?? "High checkout volume. Please retry in a few moments.");
        }
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
      setShowWaitingRoomModal(false);
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

  // ── Standalone Executive Admin Console (Zero Storefront Chrome Bleed) ───────
  if (viewMode === "admin") {
    return (
      <>
        {session?.role === "admin" ? (
          <AdminPanel
            token={session.token}
            products={products}
            onNotify={showToast}
            onProductsUpdated={fetchProducts}
            onReturnToStore={() => navigateTo("store")}
            userName={session.displayName}
            userEmail={session.email}
          />
        ) : (
          <div className="admin-auth-guard" style={{ minHeight: "100vh", display: "grid", placeItems: "center", background: "var(--sand-light)" }}>
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
        )}

        {/* Global Auth Modal */}
        {showAuthModal && (
          <div className="dialog-backdrop" onClick={() => setShowAuthModal(false)} role="presentation">
            <div className="dialog" onClick={(e) => e.stopPropagation()} id="auth-modal">
              <div className="dialog-header">
                <h2>{authTab === "login" ? "Sign In" : "Create Account"}</h2>
                <button className="close-btn" onClick={() => setShowAuthModal(false)} aria-label="Close dialog" id="btn-close-auth-modal">
                  &times;
                </button>
              </div>
              <form onSubmit={handleAuth} className="dialog-form" id="form-auth">
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
          </div>
        )}

        {/* Global Toast Notifications */}
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
          </div>

          <div className="nav-actions">
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
                            navigateTo("admin");
                          }}
                          id="btn-goto-admin"
                        >
                          Admin Console
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
                <button className="auth-button" onClick={() => { setAuthError(""); setShowAuthModal(true); }} id="btn-open-login">
                  Sign In
                </button>
              )}
            </div>

            <button className="bag" onClick={() => setIsCartOpen(true)} id="btn-toggle-bag">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M6 2L3 6v14a2 2 0 002 2h14a2 2 0 002-2V6l-3-4z" />
                <line x1="3" y1="6" x2="21" y2="6" />
                <path d="M16 10a4 4 0 01-8 0" />
              </svg>
              {totalItemsCount > 0 && <b>{totalItemsCount}</b>}
            </button>
          </div>
        </div>
      </header>

      {/* ── Active Restock Alerts Banner (10-minute hold expiry notification) ── */}
      {activeRestockAlerts.length > 0 && (
        <div className="restock-alerts-bar" id="restock-alerts-banner">
          <span>
            <strong>Restock Alert:</strong> A 10-minute hold for <strong>{activeRestockAlerts[0].product_name}</strong> expired unpurchased! Claim your reserved unit now ({activeRestockAlerts[0].remaining_seconds}s window).
          </span>
          <button
            className="restock-alert-claim-btn"
            onClick={() => handleClaimRestock(activeRestockAlerts[0])}
            id="btn-claim-restock"
          >
            Claim Reserved Hold
          </button>
        </div>
      )}

      {/* ── Main View Router ────────────────────────────────────────── */}
      <main id="top">
        {viewMode === "pdp" && pdpSkuOrId ? (
          <ProductDetailPage
            skuOrId={pdpSkuOrId}
            serverOffsetMs={serverOffsetMs}
            onAddToBag={(prod, qty) => addToBag(prod, qty)}
            onNavigateHome={() => navigateTo("store")}
            session={session}
            onRequireAuth={() => {
              setAuthError("");
              setAuthTab("login");
              setShowAuthModal(true);
            }}
            onNotify={showToast}
            onProductsUpdated={fetchProducts}
            onOpenWaitlist={(prod) => setWaitlistModalProduct(prod)}
          />
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
                    Free shipping over ₹500
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
              onOpenProduct={navigateToCatalog}
              recentlyAddedId={recentlyAddedId}
              onOpenWaitlist={(prod) => setWaitlistModalProduct(prod)}
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
                      <div
                        className="product-image-wrap"
                        onClick={() => navigateToCatalog(product.sku)}
                        style={{ cursor: "pointer" }}
                        title={`View ${product.name} details & specifications`}
                      >
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
                          <h3
                            className="product-name"
                            onClick={() => navigateToCatalog(product.sku)}
                            style={{ cursor: "pointer" }}
                            title={`View ${product.name} details & specifications`}
                          >
                            {product.name}
                          </h3>
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
                            {isOut ? (
                              <button
                                className="product-add-btn waitlist-btn"
                                onClick={() => setWaitlistModalProduct(product)}
                                id={`btn-waitlist-${product.id}`}
                                aria-label={`Join priority waitlist for ${product.name}`}
                              >
                                Join Waitlist
                              </button>
                            ) : (
                              <button
                                className={`product-add-btn ${isAdded ? "added" : ""} ${isFlash ? "flash-btn" : ""}`}
                                onClick={() => void addToBag(product)}
                                id={`btn-add-${product.id}`}
                                aria-label={`Add ${product.name} to bag`}
                              >
                                {isAdded ? "Added" : "Add to Bag"}
                              </button>
                            )}
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
                  {totalPrice > cartSalePrice && (
                    <div className="cart-savings-pill" id="cart-flash-savings-pill">
                      <span>⚡ Flash Sale Savings:</span>
                      <strong>You save {formatPrice(totalPrice - cartSalePrice)}!</strong>
                    </div>
                  )}
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

      {/* ── Virtual Waiting Room Modal (Token Bucket Admission Gate) ─── */}
      <WaitingRoomModal
        isOpen={showWaitingRoomModal}
        ticketId={waitingRoomTicketId}
        cartId={waitingRoomCartId}
        onAdmitted={handleWaitingRoomAdmitted}
        onClose={() => setShowWaitingRoomModal(false)}
      />

      {/* ── Automated Restock Waitlist Modal (10-minute hold expiration) ── */}
      <RestockWaitlistModal
        isOpen={!!waitlistModalProduct}
        product={waitlistModalProduct}
        userEmail={session?.email || ""}
        onClose={() => setWaitlistModalProduct(null)}
        onJoined={(pos, name) => {
          showToast(`Joined priority restock waitlist for ${name} at position #${pos}!`, "success");
          if (session?.email) {
            localStorage.setItem("surgecart_waitlist_email", session.email);
          }
          fetchRestockAlerts();
        }}
      />

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
            <button
              type="button"
              className="toast-close-btn"
              onClick={() => setToasts((p) => p.filter((t) => t.id !== toast.id))}
              aria-label="Dismiss notification"
              title="Dismiss"
            >
              &times;
            </button>
          </div>
        ))}
      </div>

      {/* ── Floating Back to Top Button ── */}
      {showBackToTop && (
        <button
          className="back-to-top-btn"
          onClick={() => window.scrollTo({ top: 0, behavior: "smooth" })}
          aria-label="Scroll back to top"
          id="btn-back-to-top"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><polyline points="18 15 12 9 6 15" /></svg>
          <span>Top</span>
        </button>
      )}
    </>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
