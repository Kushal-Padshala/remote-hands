import { useState, useEffect } from 'react';
import type { ApprovalRow } from '@remote-hands/shared';

export interface ApprovalSheetProps {
  approval: ApprovalRow | null;
  frameBase64?: string | null | undefined;
  onApprove: (approvalId: string) => Promise<void>;
  onReject: (approvalId: string, reason?: string) => Promise<void>;
  onDismiss?: () => void;
  loading?: boolean | undefined;
}

const QUICK_REASONS = [
  'Change proposed content',
  'Wrong page or account',
  'Save as draft instead',
  'Cancel this action',
];

export function ApprovalSheet({
  approval,
  frameBase64,
  onApprove,
  onReject,
  onDismiss,
  loading,
}: ApprovalSheetProps) {
  const [isRejecting, setIsRejecting] = useState(false);
  const [rejectionReason, setRejectionReason] = useState('');

  const [timeLeftSeconds, setTimeLeftSeconds] = useState<number>(() => {
    if (!approval?.expires_at) return 600;
    return Math.max(0, Math.round((new Date(approval.expires_at).getTime() - Date.now()) / 1000));
  });

  useEffect(() => {
    setIsRejecting(false);
    setRejectionReason('');
  }, [approval?.id]);

  useEffect(() => {
    if (!approval?.expires_at) {
      setTimeLeftSeconds(600);
      return;
    }
    const update = () => {
      const diff = Math.max(0, Math.round((new Date(approval.expires_at).getTime() - Date.now()) / 1000));
      setTimeLeftSeconds(diff);
    };
    update();
    const interval = setInterval(update, 1000);
    return () => clearInterval(interval);
  }, [approval?.id, approval?.expires_at]);

  if (!approval) return null;

  const isExpired = timeLeftSeconds <= 0;
  const isHighRisk = approval.risk === 'high';
  const previewImage = approval.frame_path || frameBase64;

  const mins = Math.floor(timeLeftSeconds / 60);
  const secs = timeLeftSeconds % 60;
  const timeLabel = isExpired ? 'Expired' : `${mins}:${secs < 10 ? '0' : ''}${secs}`;
  const isUrgent = !isExpired && timeLeftSeconds < 60;

  const handleCancelReject = () => {
    setIsRejecting(false);
    setRejectionReason('');
  };

  const handleDismiss = () => {
    setIsRejecting(false);
    setRejectionReason('');
    if (onDismiss) {
      onDismiss();
    }
  };

  const handleConfirmReject = () => {
    if (isExpired) return;
    const reason = rejectionReason.trim() || undefined;
    setIsRejecting(false);
    setRejectionReason('');
    onReject(approval.id, reason);
  };

  return (
    <div
      className="sheet-overlay approval-overlay"
      data-testid="approval-sheet"
      onClick={(e) => {
        if (e.target === e.currentTarget) {
          handleDismiss();
        }
      }}
    >
      <div className="sheet-content approval-sheet" role="dialog" aria-modal="true" aria-label="Action approval">
        <div
          className="sheet-grabber"
          onClick={handleDismiss}
          style={{ cursor: onDismiss ? 'pointer' : 'default' }}
        />

        {isRejecting ? (
          <div data-testid="rejection-form" className="approval-body">
            <div className="approval-topbar">
              <div className="approval-title-group">
                <h3 className="approval-title">Why are you rejecting this?</h3>
                <span className={`approval-timer ${isExpired ? 'expired' : isUrgent ? 'urgent' : ''}`}>
                  {timeLabel}
                </span>
              </div>
              <div className="approval-top-actions">
                <button
                  type="button"
                  className="approval-ghost-btn"
                  onClick={handleCancelReject}
                  disabled={loading}
                >
                  Back
                </button>
                {onDismiss && (
                  <button
                    type="button"
                    data-testid="close-rejection-btn"
                    onClick={handleDismiss}
                    aria-label="Close"
                    className="approval-close-btn"
                  >
                    ✕
                  </button>
                )}
              </div>
            </div>

            <p className="approval-desc">
              Your feedback will be sent directly to the agent so it knows why this action was rejected and how to adjust.
            </p>

            <div className="approval-quick-grid">
              {QUICK_REASONS.map((suggestion) => (
                <button
                  key={suggestion}
                  type="button"
                  onClick={() => setRejectionReason(suggestion)}
                  className={`approval-quick-chip ${rejectionReason === suggestion ? 'selected' : ''}`}
                >
                  {suggestion}
                </button>
              ))}
            </div>

            <textarea
              data-testid="rejection-reason-input"
              rows={3}
              value={rejectionReason}
              onChange={(e) => setRejectionReason(e.target.value)}
              placeholder="Explain what to change or why you rejected (e.g. adjust tone, delete hashtags, cancel task)..."
              className="approval-textarea"
            />

            {isExpired ? (
              <div className="approval-actions-single">
                <button
                  type="button"
                  className="btn btn-secondary approval-btn-secondary"
                  data-testid="dismiss-rejection-btn"
                  onClick={handleDismiss}
                >
                  Dismiss
                </button>
              </div>
            ) : (
              <div className="approval-actions-duo">
                <button
                  type="button"
                  className="btn btn-secondary approval-btn-secondary"
                  disabled={loading}
                  onClick={handleCancelReject}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  className="btn btn-reject approval-btn-reject"
                  data-testid="confirm-reject-btn"
                  disabled={loading}
                  onClick={handleConfirmReject}
                >
                  {loading ? 'Rejecting...' : 'Reject & Send'}
                </button>
              </div>
            )}
          </div>
        ) : (
          <div className="approval-body">
            <div className="approval-topbar">
              <div className="approval-title-group">
                <div className="approval-icon" aria-hidden="true">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
                  </svg>
                </div>
                <h3 className="approval-title">Action Approval Required</h3>
              </div>
              <div className="approval-top-actions">
                <span className={`approval-timer ${isExpired ? 'expired' : isUrgent ? 'urgent' : ''}`}>
                  {timeLabel}
                </span>
                <span className={`approval-risk ${isHighRisk ? 'high' : 'medium'}`}>
                  {approval.risk}
                </span>
                {onDismiss && (
                  <button
                    type="button"
                    data-testid="close-approval-btn"
                    onClick={handleDismiss}
                    aria-label="Close"
                    className="approval-close-btn"
                  >
                    ✕
                  </button>
                )}
              </div>
            </div>

            <div className="approval-action-row">
              <div className="approval-label">Requested Action</div>
              <div className="approval-action-name">{approval.action_kind}</div>
            </div>

            <div className="approval-summary-card">
              <div className="approval-label">Proposed Content & Details</div>
              <div className="approval-summary-text">{approval.summary}</div>
            </div>

            {previewImage && (
              <div className="approval-preview">
                <div className="approval-preview-header">
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <rect x="2" y="3" width="20" height="14" rx="2" ry="2" />
                    <line x1="8" y1="21" x2="16" y2="21" />
                    <line x1="12" y1="17" x2="12" y2="21" />
                  </svg>
                  <span>Screen preview</span>
                </div>
                <img
                  src={previewImage}
                  alt="Screen state before action approval"
                  data-testid="approval-screen-preview"
                  className="approval-preview-img"
                />
              </div>
            )}

            {isExpired ? (
              <div className="approval-actions-single">
                <button
                  type="button"
                  className="btn btn-secondary approval-btn-secondary"
                  data-testid="dismiss-approval-btn"
                  onClick={handleDismiss}
                >
                  Dismiss
                </button>
              </div>
            ) : (
              <div className="approval-actions-duo">
                <button
                  className="btn btn-reject approval-btn-reject"
                  data-testid="reject-approval-btn"
                  disabled={loading}
                  onClick={() => setIsRejecting(true)}
                >
                  Reject
                </button>
                <button
                  className="btn btn-approve approval-btn-approve"
                  data-testid="approve-approval-btn"
                  disabled={loading}
                  onClick={() => onApprove(approval.id)}
                >
                  {loading ? 'Confirming...' : 'Approve'}
                </button>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
