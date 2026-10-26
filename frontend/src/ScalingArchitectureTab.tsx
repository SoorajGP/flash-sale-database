import { useCallback, useEffect, useState } from "react";

type ClusterStatus = {
  cqrs_read_replicas: {
    cqrs_enabled: boolean;
    primary_engine: string;
    read_replica_engine: string;
    dedicated_replica_active: boolean;
    write_pool_size: number;
    read_pool_size: number;
  };
  table_partitioning: {
    engine: string;
    partitioning_type: string;
    partition_key: string;
    current_partition_suffix: string;
    partition_interval: string;
    tables: Record<
      string,
      Array<{
        partition_name: string;
        bound_expression: string;
        total_bytes: number;
        estimated_rows: number;
        is_current: boolean;
      }>
    >;
    notice?: string;
  };
  redis_available: boolean;
};

type WaitingRoomTelemetry = {
  active: boolean;
  engine: string;
  waiting_depth: number;
  total_tickets_issued: number;
  current_queue_served: number;
  drain_rate_per_sec: number;
  burst_capacity: number;
  ticket_ttl_minutes: number;
};

export function ScalingArchitectureTab({
  token,
  onNotify,
}: {
  token: string;
  onNotify: (msg: string, type?: "success" | "error" | "info") => void;
}) {
  const [clusterData, setClusterData] = useState<ClusterStatus | null>(null);
  const [queueMetrics, setQueueMetrics] = useState<WaitingRoomTelemetry | null>(null);
  const [loading, setLoading] = useState(true);
  const [isTogglingGate, setIsTogglingGate] = useState(false);
  const [isSyncingPartitions, setIsSyncingPartitions] = useState(false);
  const [isAdmittingBatch, setIsAdmittingBatch] = useState(false);
  const [isReclaiming, setIsReclaiming] = useState(false);

  const fetchMetrics = useCallback(() => {
    setLoading(true);
    Promise.all([
      fetch("/api/v1/system/cluster").then((r) => (r.ok ? r.json() : null)),
      fetch("/api/v1/waiting-room/metrics").then((r) => (r.ok ? r.json() : null)),
    ])
      .then(([cluster, queue]) => {
        if (cluster) setClusterData(cluster);
        if (queue) setQueueMetrics(queue);
      })
      .catch(() => onNotify("Could not load architecture telemetry.", "error"))
      .finally(() => setLoading(false));
  }, [onNotify]);

  useEffect(() => {
    fetchMetrics();
    const id = setInterval(fetchMetrics, 5000);
    return () => clearInterval(id);
  }, [fetchMetrics]);

  const handleToggleWaitingRoom = async () => {
    if (!queueMetrics) return;
    setIsTogglingGate(true);
    try {
      const nextState = !queueMetrics.active;
      const res = await fetch("/api/v1/admin/waiting-room/configure", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ enabled: nextState }),
      });
      if (res.ok) {
        onNotify(
          nextState
            ? "Virtual Waiting Room Gate activated. Shoppers will receive numbered queue tickets."
            : "Virtual Waiting Room Gate bypassed. Direct checkout enabled.",
          "success"
        );
        fetchMetrics();
      } else {
        onNotify("Failed to update waiting room configuration.", "error");
      }
    } catch {
      onNotify("Error communicating with waiting room service.", "error");
    } finally {
      setIsTogglingGate(false);
    }
  };

  const handleSyncPartitions = async () => {
    setIsSyncingPartitions(true);
    try {
      const res = await fetch("/api/v1/admin/partitions/sync?months_ahead=4", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.ok) {
        const d = await res.json();
        onNotify(
          `Verified ${d.partitions_maintained?.length || 0} monthly partitions ahead of flash sale.`,
          "success"
        );
        fetchMetrics();
      } else {
        onNotify("Failed to sync date partitions.", "error");
      }
    } catch {
      onNotify("Error triggering partition sync.", "error");
    } finally {
      setIsSyncingPartitions(false);
    }
  };

  const handleBurstAdmit = async () => {
    setIsAdmittingBatch(true);
    try {
      const res = await fetch("/api/v1/admin/waiting-room/admit", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ count: 50 }),
      });
      if (res.ok) {
        const d = await res.json();
        onNotify(`Admitted batch of ${d.admitted_count} waiting shoppers to checkout.`, "success");
        fetchMetrics();
      } else {
        onNotify("Failed to burst admit queue batch.", "error");
      }
    } catch {
      onNotify("Error communicating with queue inflow controller.", "error");
    } finally {
      setIsAdmittingBatch(false);
    }
  };

  const handleReclaimReservations = async () => {
    setIsReclaiming(true);
    try {
      const res = await fetch("/api/v1/admin/reservations/cleanup", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.ok) {
        const d = await res.json();
        onNotify(
          `Reclaimed ${d.released_count} expired hold(s) & dispatched automated restock alerts.`,
          "success"
        );
        fetchMetrics();
      } else {
        onNotify("Failed to release expired reservations.", "error");
      }
    } catch {
      onNotify("Error releasing reservations.", "error");
    } finally {
      setIsReclaiming(false);
    }
  };

  if (loading && !clusterData) {
    return <div className="analytics-loading">Loading architectural scaling topology...</div>;
  }

  const cqrs = clusterData?.cqrs_read_replicas;
  const part = clusterData?.table_partitioning;

  return (
    <div className="scaling-pane" id="scaling-architecture-pane">
      {/* ── Section 1: CQRS & Read Replicas ── */}
      <div className="scaling-card">
        <div className="scaling-card-header">
          <div>
            <div className="scaling-badge-pill">High Concurrency Architecture</div>
            <h3 className="scaling-title">CQRS &amp; Read Replicas (Traffic Segregation)</h3>
            <p className="scaling-desc">
              All read-heavy traffic (browsing the catalog, viewing product reviews, and analytics) is
              isolated to the read-replica pool, reserving the primary PostgreSQL instance exclusively for
              checkout write transactions and row-level inventory locks.
            </p>
          </div>
          <span className="mate-status-badge mate-status-paid" style={{ alignSelf: "flex-start" }}>
            CQRS Active
          </span>
        </div>

        <div className="scaling-node-grid">
          <div className="scaling-node-card write-node">
            <div className="node-top">
              <span className="node-type-tag">Primary Write Instance</span>
              <span className="node-badge-live">Exclusive Write Path</span>
            </div>
            <div className="node-endpoint">{cqrs?.primary_engine || "postgresql+psycopg://surgecart:5432"}</div>
            <div className="node-details">
              <div>Reserved for: <strong>Checkout, Atomic Holds, Orders &amp; Payments</strong></div>
              <div>Connection Pool Size: <strong>{cqrs?.write_pool_size || 30} connections</strong></div>
              <div>Transaction Isolation: <strong>Read Committed / Serializable Locks</strong></div>
            </div>
          </div>

          <div className="scaling-node-card read-node">
            <div className="node-top">
              <span className="node-type-tag">Read-Replica Pool</span>
              <span className="node-badge-live replica">Read Optimized</span>
            </div>
            <div className="node-endpoint">{cqrs?.read_replica_engine || "postgresql+psycopg://surgecart-replica:5432"}</div>
            <div className="node-details">
              <div>Serves: <strong>Catalog Browsing, Customer Reviews, Analytics &amp; Search</strong></div>
              <div>Connection Pool Size: <strong>{cqrs?.read_pool_size || 30} read connections</strong></div>
              <div>Dedicated Replica: <strong>{cqrs?.dedicated_replica_active ? "Multi-Host Cluster" : "Dedicated Read Pool"}</strong></div>
            </div>
          </div>
        </div>
      </div>

      {/* ── Section 2: Table Partitioning ── */}
      <div className="scaling-card">
        <div className="scaling-card-header">
          <div>
            <div className="scaling-badge-pill">I/O &amp; Storage Optimization</div>
            <h3 className="scaling-title">Table Partitioning for High-Volume Orders</h3>
            <p className="scaling-desc">
              Partitions the <code>orders</code> and <code>inventory_movements</code> tables by date range
              (monthly partitions) so queries on active flash sales only scan the latest partition, reducing
              index B-Tree depth and disk I/O under massive order spikes.
            </p>
          </div>
          <button
            className="admin-btn secondary"
            onClick={() => void handleSyncPartitions()}
            disabled={isSyncingPartitions}
            id="btn-sync-partitions"
          >
            {isSyncingPartitions ? "Syncing..." : "Pre-create Partitions"}
          </button>
        </div>

        <div className="partition-tables-grid">
          {["orders", "inventory_movements"].map((tbl) => {
            const list = part?.tables?.[tbl] || [];
            return (
              <div key={tbl} className="partition-box">
                <div className="partition-box-header">
                  <strong>Table: {tbl}</strong>
                  <span className="partition-key-tag">Partition Key: created_at (Monthly)</span>
                </div>
                <div className="partition-list">
                  {list.slice(0, 6).map((p) => (
                    <div
                      key={p.partition_name}
                      className={`partition-item ${p.is_current ? "current-partition" : ""}`}
                    >
                      <div className="partition-item-name">
                        <span>{p.partition_name}</span>
                        {p.is_current && <span className="active-part-tag">Current Active</span>}
                      </div>
                      <div className="partition-item-meta">
                        <span>{p.bound_expression}</span>
                        <span>{p.estimated_rows} rows</span>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* ── Section 3: Virtual Waiting Room ── */}
      <div className="scaling-card">
        <div className="scaling-card-header">
          <div>
            <div className="scaling-badge-pill">Inflow Rate Control</div>
            <h3 className="scaling-title">Queue-Based Virtual Waiting Room (Token Bucket / Leaky Bucket)</h3>
            <p className="scaling-desc">
              For 100,000+ users hitting checkout simultaneously, places incoming requests into an
              in-memory queue that issues numbered tickets before allowing users to hit checkout, protecting
              database connections and row locks.
            </p>
          </div>
          <div style={{ display: "flex", gap: 10 }}>
            <button
              className={`admin-btn ${queueMetrics?.active ? "danger-btn" : ""}`}
              onClick={() => void handleToggleWaitingRoom()}
              disabled={isTogglingGate}
              id="btn-toggle-waiting-room"
            >
              {isTogglingGate
                ? "Updating..."
                : queueMetrics?.active
                ? "Deactivate Waiting Room"
                : "Activate Waiting Room"}
            </button>
            <button
              className="admin-btn secondary"
              onClick={() => void handleBurstAdmit()}
              disabled={isAdmittingBatch || !queueMetrics?.active}
              id="btn-burst-admit"
            >
              {isAdmittingBatch ? "Admitting..." : "Burst Admit Next 50"}
            </button>
          </div>
        </div>

        <div className="kpi-grid" style={{ marginBottom: 16 }}>
          <div className="kpi-card">
            <span className="kpi-label">Waiting Room Gate</span>
            <div className="kpi-value" style={{ color: queueMetrics?.active ? "#e05c2e" : "#1a3828" }}>
              {queueMetrics?.active ? "ACTIVE (Gated)" : "BYPASS (Direct)"}
            </div>
            <span className="kpi-sub">
              {queueMetrics?.active ? "Numbered queue tickets required" : "Low traffic auto-admit"}
            </span>
          </div>

          <div className="kpi-card">
            <span className="kpi-label">Current Queue Depth</span>
            <div className="kpi-value">{queueMetrics?.waiting_depth || 0}</div>
            <span className="kpi-sub">Shoppers waiting for admission</span>
          </div>

          <div className="kpi-card">
            <span className="kpi-label">Total Numbered Tickets</span>
            <div className="kpi-value">{queueMetrics?.total_tickets_issued || 0}</div>
            <span className="kpi-sub">Monotonically issued IDs</span>
          </div>

          <div className="kpi-card">
            <span className="kpi-label">Now Serving Ticket</span>
            <div className="kpi-value">#{queueMetrics?.current_queue_served || 0}</div>
            <span className="kpi-sub">Rate: {queueMetrics?.drain_rate_per_sec || 50} checkouts/sec</span>
          </div>
        </div>
      </div>

      {/* ── Section 4: Automated Restock Waitlist ── */}
      <div className="scaling-card">
        <div className="scaling-card-header">
          <div>
            <div className="scaling-badge-pill">Customer Retention</div>
            <h3 className="scaling-title">Automated Waitlist &amp; 10-Minute Reservation Alerts</h3>
            <p className="scaling-desc">
              If a flash sale sells out in 30 seconds, rejected shoppers enter an automated waitlist
              that automatically notifies them the instant any 10-minute cart reservation holds expire
              unpurchased.
            </p>
          </div>
          <button
            className="admin-btn"
            onClick={() => void handleReclaimReservations()}
            disabled={isReclaiming}
            id="btn-reclaim-waitlist"
          >
            {isReclaiming ? "Sweeping..." : "Reclaim Expired Holds & Alert Waitlist"}
          </button>
        </div>

        <div className="waitlist-feature-flow">
          <div className="flow-step">
            <div className="flow-number">1</div>
            <div className="flow-body">
              <strong>Flash Sale Sellout</strong>
              <p>Items sell out in seconds; excess shoppers join waitlist with atomic FIFO queue numbers.</p>
            </div>
          </div>

          <div className="flow-arrow">&rarr;</div>

          <div className="flow-step">
            <div className="flow-number">2</div>
            <div className="flow-body">
              <strong>10-Min Cart Hold Expiry</strong>
              <p>Unpurchased cart holds expire after 10 minutes. Background worker reclaims reserved stock.</p>
            </div>
          </div>

          <div className="flow-arrow">&rarr;</div>

          <div className="flow-step">
            <div className="flow-number">3</div>
            <div className="flow-body">
              <strong>Automated Alert &amp; Claim</strong>
              <p>Top waitlisted customers receive priority restock notifications with an exclusive 10-min claim window.</p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
