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
    if (!approval?.expires_at) return;
    const update = () => {
      const diff = Math.max(0, Math.round((new Date(approval.expires_at).getTime() - Date.now()) / 1000));
      setTimeLeftSeconds(diff);
    };
    update();
    const interval = setInterval(update, 1000);
    return () => clearInterval(interval);
  }, [approval?.expires_at]);

  if (!approval) return null;

  const isExpired = timeLeftSeconds <= 0;
  const isHighRisk = approval.risk === 'high';
  const previewImage = approval.frame_path || frameBase64;

  const mins = Math.floor(timeLeftSeconds / 60);
  const secs = timeLeftSeconds % 60;
  const timeLabel = isExpired ? 'Expired' : `${mins}:${secs < 10 ? '0' : ''}${secs}`;

  const handleConfirmReject = () => {
    if (isExpired) return;
    onReject(approval.id, rejectionReason.trim() || undefined);
  };

  return (
    <div
      className="sheet-overlay"
      data-testid="approval-sheet"
      onClick={(e) => {
        if (e.target === e.currentTarget && onDismiss) {
          onDismiss();
        }
      }}
    >
      <div className="sheet-content">
        <div
          className="sheet-grabber"
          onClick={onDismiss}
          style={{ cursor: onDismiss ? 'pointer' : 'default' }}
        />

        {isRejecting ? (
          <div data-testid="rejection-form">
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <h3 style={{ fontSize: '1.05rem', fontWeight: 600, color: 'var(--text-primary)' }}>
                  Why are you rejecting this?
                </h3>
                <span
                  style={{
                    fontSize: '0.75rem',
                    fontVariantNumeric: 'tabular-nums',
                    color: isExpired ? 'var(--accent-rose)' : timeLeftSeconds < 60 ? 'var(--accent-amber)' : 'var(--text-muted)',
                  }}
                >
                  ⏱ {timeLabel}
                </span>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <button
                  type="button"
                  className="btn btn-secondary"
                  style={{ padding: '4px 10px', fontSize: '0.75rem', height: 'auto', minHeight: 'unset' }}
                  onClick={() => setIsRejecting(false)}
                  disabled={loading}
                >
                  Back
                </button>
                {onDismiss && (
                  <button
                    type="button"
                    data-testid="close-rejection-btn"
                    onClick={onDismiss}
                    aria-label="Close"
                    style={{
                      background: 'rgba(255, 255, 255, 0.08)',
                      border: 'none',
                      borderRadius: '50%',
                      width: 28,
                      height: 28,
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      color: 'var(--text-muted)',
                      cursor: 'pointer',
                      fontSize: '0.875rem',
                      lineHeight: 1,
                    }}
                  >
                    ✕
                  </button>
                )}
              </div>
            </div>

            <p style={{ fontSize: '0.8125rem', color: 'var(--text-secondary)', marginBottom: 12, lineHeight: 1.4 }}>
              Your feedback will be sent directly to the agent so it knows why this action was rejected and how to adjust.
            </p>

            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 12 }}>
              {QUICK_REASONS.map((suggestion) => (
                <button
                  key={suggestion}
                  type="button"
                  onClick={() => setRejectionReason(suggestion)}
                  style={{
                    background: rejectionReason === suggestion ? 'rgba(99, 102, 241, 0.25)' : 'rgba(255, 255, 255, 0.05)',
                    color: rejectionReason === suggestion ? 'var(--accent-cyan)' : 'var(--text-secondary)',
                    border: `1px solid ${rejectionReason === suggestion ? 'var(--accent-cyan)' : 'rgba(255, 255, 255, 0.1)'}`,
                    borderRadius: 14,
                    padding: '4px 10px',
                    fontSize: '0.75rem',
                    cursor: 'pointer',
                  }}
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
              style={{
                width: '100%',
                background: 'rgba(0, 0, 0, 0.4)',
                border: '1px solid rgba(255, 255, 255, 0.15)',
                borderRadius: 8,
                padding: '10px 12px',
                color: 'var(--text-primary)',
                fontSize: '0.875rem',
                fontFamily: 'inherit',
                resize: 'none',
                boxSizing: 'border-box',
                marginBottom: 14,
              }}
            />

            {isExpired ? (
              <div style={{ marginTop: 14 }}>
                <button
                  type="button"
                  className="btn btn-secondary"
                  data-testid="dismiss-rejection-btn"
                  style={{ width: '100%', justifyContent: 'center' }}
                  onClick={onDismiss}
                >
                  Dismiss
                </button>
              </div>
            ) : (
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                <button
                  type="button"
                  className="btn btn-secondary"
                  disabled={loading}
                  onClick={() => setIsRejecting(false)}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  className="btn btn-reject"
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
          <>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
              <h3 style={{ fontSize: '1.05rem', fontWeight: 600, color: 'var(--text-primary)' }}>
                Action Approval Required
              </h3>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <span
                  style={{
                    fontSize: '0.75rem',
                    fontVariantNumeric: 'tabular-nums',
                    color: isExpired ? 'var(--accent-rose)' : timeLeftSeconds < 60 ? 'var(--accent-amber)' : 'var(--text-muted)',
                  }}
                >
                  ⏱ {timeLabel}
                </span>
                <span
                  className="badge"
                  style={{
                    background: isHighRisk ? 'rgba(244, 63, 94, 0.15)' : 'rgba(245, 158, 11, 0.15)',
                    color: isHighRisk ? 'var(--accent-rose)' : 'var(--accent-amber)',
                    border: `1px solid ${isHighRisk ? 'rgba(244, 63, 94, 0.3)' : 'rgba(245, 158, 11, 0.3)'}`,
                  }}
                >
                  {approval.risk}
                </span>
                {onDismiss && (
                  <button
                    type="button"
                    data-testid="close-approval-btn"
                    onClick={onDismiss}
                    aria-label="Close"
                    style={{
                      background: 'rgba(255, 255, 255, 0.08)',
                      border: 'none',
                      borderRadius: '50%',
                      width: 28,
                      height: 28,
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      color: 'var(--text-muted)',
                      cursor: 'pointer',
                      fontSize: '0.875rem',
                      lineHeight: 1,
                      marginLeft: 2,
                    }}
                  >
                    ✕
                  </button>
                )}
              </div>
            </div>

            <div style={{ marginBottom: 12 }}>
              <div style={{ fontSize: '0.6875rem', color: 'var(--text-muted)', textTransform: 'uppercase', marginBottom: 4, letterSpacing: '0.04em', fontWeight: 600 }}>
                Requested Action
              </div>
              <div style={{ fontWeight: 600, color: 'var(--accent-cyan)', fontSize: '0.9375rem', fontFamily: 'var(--font-mono)' }}>
                {approval.action_kind}
              </div>
            </div>

            <div
              style={{
                marginBottom: 14,
                background: 'rgba(255, 255, 255, 0.03)',
                border: '1px solid rgba(255, 255, 255, 0.08)',
                borderRadius: 8,
                padding: '12px 14px',
              }}
            >
              <div style={{ fontSize: '0.6875rem', color: 'var(--text-muted)', textTransform: 'uppercase', marginBottom: 6, letterSpacing: '0.04em', fontWeight: 600 }}>
                Proposed Content & Details
              </div>
              <div style={{ fontSize: '0.875rem', color: 'var(--text-primary)', lineHeight: 1.5, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                {approval.summary}
              </div>
            </div>

            {previewImage && (
              <div
                style={{
                  marginBottom: 16,
                  borderRadius: 10,
                  overflow: 'hidden',
                  border: '1px solid rgba(255, 255, 255, 0.12)',
                  background: '#09090d',
                }}
              >
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 6,
                    padding: '6px 10px',
                    background: 'rgba(255, 255, 255, 0.04)',
                    fontSize: '0.6875rem',
                    color: 'var(--text-muted)',
                    borderBottom: '1px solid rgba(255, 255, 255, 0.06)',
                  }}
                >
                  <span aria-hidden="true">🖥️</span>
                  <span style={{ fontWeight: 500 }}>Live Screen Preview</span>
                </div>
                <img
                  src={previewImage}
                  alt="Screen state before action approval"
                  data-testid="approval-screen-preview"
                  style={{
                    width: '100%',
                    maxHeight: '220px',
                    objectFit: 'contain',
                    display: 'block',
                    background: '#000',
                  }}
                />
              </div>
            )}

            {isExpired ? (
              <div style={{ marginTop: 14 }}>
                <button
                  type="button"
                  className="btn btn-secondary"
                  data-testid="dismiss-approval-btn"
                  style={{ width: '100%', justifyContent: 'center' }}
                  onClick={onDismiss}
                >
                  Dismiss
                </button>
              </div>
            ) : (
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginTop: 14 }}>
                <button
                  className="btn btn-reject"
                  data-testid="reject-approval-btn"
                  disabled={loading}
                  onClick={() => setIsRejecting(true)}
                >
                  Reject
                </button>
                <button
                  className="btn btn-approve"
                  data-testid="approve-approval-btn"
                  disabled={loading}
                  onClick={() => onApprove(approval.id)}
                >
                  {loading ? 'Confirming...' : 'Approve'}
                </button>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
