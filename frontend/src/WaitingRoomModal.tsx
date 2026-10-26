import { useEffect, useState } from "react";

type WaitingRoomModalProps = {
  isOpen: boolean;
  ticketId: string;
  cartId: string;
  onAdmitted: (token: string) => void;
  onClose: () => void;
};

type TicketStatus = {
  ticket_id: string;
  queue_number: number;
  current_serving: number;
  ahead_in_queue: number;
  status: "WAITING" | "ADMITTED" | "COMPLETED" | "EXPIRED" | "NOT_FOUND";
  estimated_wait_seconds: number;
  admission_token?: string | null;
};

export function WaitingRoomModal({
  isOpen,
  ticketId,
  cartId,
  onAdmitted,
  onClose,
}: WaitingRoomModalProps) {
  const [statusData, setStatusData] = useState<TicketStatus | null>(null);
  const [secondsRemaining, setSecondsRemaining] = useState<number>(15);

  useEffect(() => {
    if (!isOpen || !ticketId) return;

    let isMounted = true;
    const checkStatus = async () => {
      try {
        const res = await fetch(`/api/v1/waiting-room/status/${ticketId}`);
        if (res.ok) {
          const data: TicketStatus = await res.json();
          if (!isMounted) return;
          setStatusData(data);
          setSecondsRemaining(data.estimated_wait_seconds);

          if (data.status === "ADMITTED" && data.admission_token) {
            // Shopper admitted! Pass token back to proceed to checkout
            setTimeout(() => {
              if (isMounted && data.admission_token) {
                onAdmitted(data.admission_token);
              }
            }, 600);
          }
        }
      } catch {
        // Retry silently
      }
    };

    checkStatus();
    const interval = setInterval(checkStatus, 1200);

    return () => {
      isMounted = false;
      clearInterval(interval);
    };
  }, [isOpen, ticketId, onAdmitted]);

  useEffect(() => {
    if (!isOpen) return;
    const timer = setInterval(() => {
      setSecondsRemaining((p) => (p > 0 ? p - 1 : 0));
    }, 1000);
    return () => clearInterval(timer);
  }, [isOpen]);

  if (!isOpen) return null;

  const isAdmitted = statusData?.status === "ADMITTED";
  const queueNum = statusData?.queue_number ?? "...";
  const currentServing = statusData?.current_serving ?? "...";
  const ahead = statusData?.ahead_in_queue ?? "...";

  return (
    <div className="modal-backdrop" onClick={onClose} id="waiting-room-modal-backdrop">
      <div
        className="waiting-room-dialog"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="wr-title"
      >
        <div className="waiting-room-header">
          <div className="wr-badge">High Concurrency Flash Sale</div>
          <h2 id="wr-title" className="wr-heading">
            Virtual Waiting Room
          </h2>
          <p className="wr-subtitle">
            To ensure fair atomic allocation and prevent checkout system crashes, we are issuing
            numbered tickets. Your position in line is reserved.
          </p>
        </div>

        <div className="wr-ticket-card">
          <div className="wr-ticket-top">
            <span className="wr-ticket-label">Your Queue Ticket</span>
            <span className="wr-ticket-id">{ticketId}</span>
          </div>

          <div className="wr-number-display">
            <span className="wr-hash">#</span>
            <span className="wr-number">{queueNum}</span>
          </div>

          <div className="wr-serving-pill">
            <span>Now Serving: <strong>#{currentServing}</strong></span>
            <span className="wr-dot" />
            <span>Shoppers ahead: <strong>{ahead}</strong></span>
          </div>
        </div>

        <div className="wr-progress-section">
          <div className="wr-progress-bar-wrap">
            <div
              className={`wr-progress-bar ${isAdmitted ? "admitted" : "active"}`}
              style={{
                width: isAdmitted ? "100%" : "75%",
              }}
            />
          </div>
          <div className="wr-progress-meta">
            {isAdmitted ? (
              <span className="wr-status-admitted">Ticket Admitted! Proceeding to checkout...</span>
            ) : (
              <span>Estimated wait time: <strong>~{secondsRemaining}s</strong></span>
            )}
            <span className="wr-rate-note">Rate: 50 checkouts / sec</span>
          </div>
        </div>

        <div className="wr-tips">
          <div className="wr-tip-icon">&bull;</div>
          <div className="wr-tip-text">
            Please keep this tab open. Your checkout will automatically resume the moment your ticket is admitted.
          </div>
        </div>

        <div className="wr-actions">
          <button className="admin-btn secondary" onClick={onClose} id="btn-cancel-waiting">
            Return to Cart
          </button>
        </div>
      </div>
    </div>
  );
}
