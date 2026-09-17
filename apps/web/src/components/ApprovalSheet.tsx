import type { ApprovalRow } from '@remote-hands/shared';

export interface ApprovalSheetProps {
  approval: ApprovalRow | null;
  onApprove: (approvalId: string) => Promise<void>;
  onReject: (approvalId: string) => Promise<void>;
  loading?: boolean | undefined;
}

export function ApprovalSheet({ approval, onApprove, onReject, loading }: ApprovalSheetProps) {
  if (!approval) return null;

  const isHighRisk = approval.risk === 'high';

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

        <div style={{ marginBottom: 16 }}>
          <div style={{ fontSize: '0.6875rem', color: 'var(--text-muted)', textTransform: 'uppercase', marginBottom: 4, letterSpacing: '0.04em', fontWeight: 600 }}>
            Requested Action
          </div>
          <div style={{ fontWeight: 600, color: 'var(--accent-cyan)', marginBottom: 6, fontSize: '0.9375rem', fontFamily: 'var(--font-mono)' }}>
            {approval.action_kind}
          </div>
          <div style={{ fontSize: '0.875rem', color: 'var(--text-secondary)', lineHeight: 1.5 }}>
            {approval.summary}
          </div>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginTop: 18 }}>
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
