import type { ApprovalRow } from '@remote-hands/shared';

export interface ApprovalSheetProps {
  approval: ApprovalRow | null;
  onApprove: (approvalId: string) => Promise<void>;
  onReject: (approvalId: string) => Promise<void>;
  loading?: boolean | undefined;
}

export function ApprovalSheet({ approval, onApprove, onReject, loading }: ApprovalSheetProps) {
  if (!approval) return null;

  return (
    <div className="sheet-overlay" data-testid="approval-sheet">
      <div className="sheet-content">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
          <h3 style={{ fontSize: '1.125rem', fontWeight: 700 }}>Action Approval Required</h3>
          <span
            className="badge"
            style={{
              background: approval.risk === 'high' ? 'rgba(244, 63, 94, 0.2)' : 'rgba(245, 158, 11, 0.2)',
              color: approval.risk === 'high' ? 'var(--accent-rose)' : 'var(--accent-amber)',
            }}
          >
            {approval.risk}
          </span>
        </div>

        <div style={{ marginBottom: 16 }}>
          <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', textTransform: 'uppercase', marginBottom: 4 }}>
            Action
          </div>
          <div style={{ fontWeight: 600, color: 'var(--text-primary)', marginBottom: 8 }}>
            {approval.action_kind}
          </div>
          <div style={{ fontSize: '0.875rem', color: 'var(--text-secondary)' }}>
            {approval.summary}
          </div>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginTop: 20 }}>
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
            Approve
          </button>
        </div>
      </div>
    </div>
  );
}
