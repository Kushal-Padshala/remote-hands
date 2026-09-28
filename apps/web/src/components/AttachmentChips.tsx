import type { ContextAttachment } from '@remote-hands/shared';

export interface AttachmentChipsProps {
  attachments: ContextAttachment[];
  onRemove: (attachmentId: string) => void;
}

export function AttachmentChips({ attachments, onRemove }: AttachmentChipsProps) {
  if (!attachments || attachments.length === 0) return null;

  return (
    <div className="attachment-chips-container" style={{ display: 'flex', flexWrap: 'wrap', gap: '6px', marginBottom: '8px' }}>
      {attachments.map((att) => {
        let icon = '🌐';
        let label = '';

        if (att.type === 'browser_tab') {
          icon = '🌐';
          label = `${att.browser}: ${att.title}`;
        } else if (att.type === 'app_window') {
          icon = '💻';
          label = `${att.app}: ${att.title || att.app}`;
        } else if (att.type === 'local_file') {
          icon = '📄';
          label = att.name;
        }

        return (
          <div
            key={att.id}
            className="attachment-chip"
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: '6px',
              backgroundColor: 'rgba(255, 255, 255, 0.08)',
              border: '1px solid rgba(255, 255, 255, 0.15)',
              borderRadius: '16px',
              padding: '3px 10px',
              fontSize: '12px',
              color: '#f0f0f0',
              backdropFilter: 'blur(8px)',
            }}
          >
            <span>{icon}</span>
            <span style={{ maxWidth: '180px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {label}
            </span>
            <button
              type="button"
              aria-label={`Remove ${label}`}
              onClick={(e) => {
                e.stopPropagation();
                onRemove(att.id);
              }}
              style={{
                background: 'none',
                border: 'none',
                cursor: 'pointer',
                color: '#aaa',
                padding: '0 2px',
                fontSize: '14px',
                lineHeight: '1',
              }}
            >
              ×
            </button>
          </div>
        );
      })}
    </div>
  );
}
