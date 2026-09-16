export interface TimelineEventItem {
  id: string | number;
  kind: string;
  text?: string | undefined;
  time?: string | undefined;
}

export interface EventTimelineProps {
  events: TimelineEventItem[];
}

export function EventTimeline({ events }: EventTimelineProps) {
  return (
    <div className="timeline" data-testid="event-timeline">
      {events.length === 0 ? (
        <div style={{ color: 'var(--text-muted)', textAlign: 'center', padding: '16px 0' }}>
          Waiting for events...
        </div>
      ) : (
        events.map((evt) => (
          <div key={evt.id} className="timeline-item">
            <div style={{ display: 'flex', justifyContent: 'space-between', color: 'var(--text-muted)', fontSize: '0.6875rem' }}>
              <span style={{ color: 'var(--accent-cyan)', fontWeight: 600 }}>{evt.kind}</span>
              <span>{evt.time ? new Date(evt.time).toLocaleTimeString() : ''}</span>
            </div>
            {evt.text && <div style={{ marginTop: 2 }}>{evt.text}</div>}
          </div>
        ))
      )}
    </div>
  );
}
