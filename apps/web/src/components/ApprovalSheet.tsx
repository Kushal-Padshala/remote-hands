import type { ApprovalRow } from '@remote-hands/shared';

export interface ApprovalSheetProps {
  approval: ApprovalRow | null;
  frameBase64?: string | null | undefined;
  onApprove: (approvalId: string) => Promise<void>;
  onReject: (approvalId: string) => Promise<void>;
  loading?: boolean | undefined;
}

export function ApprovalSheet({
  approval,
  frameBase64,
  onApprove,
  onReject,
  loading,
}: ApprovalSheetProps) {
  if (!approval) return null;

  const isHighRisk = approval.risk === 'high';
  const previewImage = approval.frame_path || frameBase64;

  return (
    <div className="sheet-overlay" data-testid="approval-sheet">
      <div className="sheet-content">
        <div className="sheet-grabber" />

        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
          <h3 style={{ fontSize: '1.05rem', fontWeight: 600, color: 'var(--text-primary)' }}>
            Action Approval Required
          </h3>
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

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginTop: 14 }}>
          <button
            className="btn btn-reject"
            data-testid="reject-approval-btn"
            disabled={loading}
            onClick={() => onReject(approval.id)}
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
      </div>
    </div>
  );
}
