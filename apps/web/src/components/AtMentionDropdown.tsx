import { useState, useEffect, useMemo } from 'react';
import type {
  ContextAttachment,
  ContextBrowserProfile,
  ContextBrowserTarget,
  ContextHierarchy,
} from '@remote-hands/shared';

export interface AtMentionDropdownProps {
  isOpen: boolean;
  hierarchy?: ContextHierarchy | undefined;
  fetchTargetsUrl?: string | undefined;
  onSelectAttachments: (attachments: ContextAttachment[]) => void;
  onClose: () => void;
}

export function AtMentionDropdown({
  isOpen,
  hierarchy: initialHierarchy,
  fetchTargetsUrl,
  onSelectAttachments,
  onClose,
}: AtMentionDropdownProps) {
  const [hierarchy, setHierarchy] = useState<ContextHierarchy | null>(initialHierarchy ?? null);
  const [tier, setTier] = useState<'categories' | 'profiles' | 'tabs'>('categories');
  const [selectedBrowser, setSelectedBrowser] = useState<ContextBrowserTarget | null>(null);
  const [selectedProfile, setSelectedProfile] = useState<ContextBrowserProfile | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedItems, setSelectedItems] = useState<Map<string, ContextAttachment>>(new Map());

  useEffect(() => {
    if (initialHierarchy) {
      setHierarchy(initialHierarchy);
    } else if (isOpen && fetchTargetsUrl) {
      const controller = new AbortController();
      fetch(fetchTargetsUrl, { signal: controller.signal })
        .then((res) => (res.ok ? res.json() : null))
        .then((data) => {
          if (data && data.browsers) {
            setHierarchy(data);
          }
        })
        .catch(() => {});
      return () => controller.abort();
    }
  }, [isOpen, initialHierarchy, fetchTargetsUrl]);

  const handleBrowserClick = (browser: ContextBrowserTarget) => {
    setSelectedBrowser(browser);
    if (browser.profiles.length === 1) {
      setSelectedProfile(browser.profiles[0]!);
      setTier('tabs');
    } else if (browser.profiles.length > 1) {
      setTier('profiles');
    }
  };

  const handleProfileClick = (profile: ContextBrowserProfile) => {
    setSelectedProfile(profile);
    setTier('tabs');
  };

  const toggleAttachment = (attachment: ContextAttachment) => {
    setSelectedItems((prev) => {
      const next = new Map(prev);
      if (next.has(attachment.id)) {
        next.delete(attachment.id);
      } else {
        next.set(attachment.id, attachment);
      }
      return next;
    });
  };

  const handleAttachSubmit = () => {
    if (selectedItems.size > 0) {
      onSelectAttachments(Array.from(selectedItems.values()));
      setSelectedItems(new Map());
      onClose();
    }
  };

  const filteredHierarchy = useMemo(() => {
    if (!hierarchy) return null;
    const q = searchQuery.toLowerCase().trim();
    if (!q) return hierarchy;

    return {
      browsers: hierarchy.browsers.map((b) => ({
        ...b,
        profiles: b.profiles.map((p) => ({
          ...p,
          tabs: p.tabs.filter((t) => t.title.toLowerCase().includes(q) || t.url.toLowerCase().includes(q)),
        })),
      })),
      apps: hierarchy.apps.filter((a) => a.name.toLowerCase().includes(q)),
      files: hierarchy.files.filter((f) => f.name.toLowerCase().includes(q)),
    };
  }, [hierarchy, searchQuery]);

  if (!isOpen) return null;

  return (
    <div
      className="at-mention-dropdown"
      data-testid="at-mention-dropdown"
      style={{
        position: 'absolute',
        bottom: '100%',
        left: 0,
        width: '100%',
        maxWidth: '440px',
        maxHeight: '340px',
        backgroundColor: '#18181b',
        border: '1px solid rgba(255, 255, 255, 0.15)',
        borderRadius: '12px',
        boxShadow: '0 12px 32px rgba(0, 0, 0, 0.6)',
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
        zIndex: 1000,
        marginBottom: '8px',
        color: '#f4f4f5',
        fontFamily: 'system-ui, -apple-system, sans-serif',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '8px 12px',
          borderBottom: '1px solid rgba(255, 255, 255, 0.1)',
          backgroundColor: '#202024',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          {tier !== 'categories' && (
            <button
              type="button"
              onClick={() => {
                if (tier === 'tabs' && selectedBrowser && selectedBrowser.profiles.length > 1) {
                  setTier('profiles');
                } else {
                  setTier('categories');
                }
              }}
              style={{
                background: 'none',
                border: 'none',
                color: '#38bdf8',
                cursor: 'pointer',
                fontSize: '12px',
                padding: '2px 4px',
              }}
            >
              ← Back
            </button>
          )}
          <span style={{ fontSize: '12px', fontWeight: 600 }}>
            {tier === 'categories'
              ? 'Attach Context (@)'
              : tier === 'profiles'
              ? `${selectedBrowser?.name} Profiles`
              : `${selectedBrowser?.name} Tabs`}
          </span>
        </div>
        <button
          type="button"
          onClick={onClose}
          style={{
            background: 'none',
            border: 'none',
            color: '#71717a',
            cursor: 'pointer',
            fontSize: '14px',
          }}
        >
          ✕
        </button>
      </div>

      <div style={{ padding: '6px 12px', borderBottom: '1px solid rgba(255, 255, 255, 0.05)' }}>
        <input
          type="text"
          placeholder="Filter tabs, apps, files..."
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          style={{
            width: '100%',
            backgroundColor: '#27272a',
            border: '1px solid rgba(255, 255, 255, 0.1)',
            borderRadius: '6px',
            color: '#fff',
            padding: '4px 8px',
            fontSize: '12px',
            outline: 'none',
            boxSizing: 'border-box',
          }}
        />
      </div>

      <div style={{ flex: 1, overflowY: 'auto', padding: '6px 8px' }}>
        {tier === 'categories' && (
          <div>
            <div style={{ fontSize: '11px', color: '#a1a1aa', padding: '4px 6px', fontWeight: 600 }}>
              Browsers
            </div>
            {filteredHierarchy?.browsers.map((b) => (
              <div
                key={b.id}
                onClick={() => handleBrowserClick(b)}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  padding: '6px 8px',
                  borderRadius: '6px',
                  cursor: 'pointer',
                  fontSize: '13px',
                }}
              >
                <span>🌐 {b.name}</span>
                <span style={{ fontSize: '11px', color: '#71717a' }}>
                  {b.profiles.reduce((acc, p) => acc + p.tabs.length, 0)} tabs →
                </span>
              </div>
            ))}

            <div style={{ fontSize: '11px', color: '#a1a1aa', padding: '6px 6px 4px', fontWeight: 600 }}>
              Running Apps
            </div>
            {filteredHierarchy?.apps.map((a) => {
              const isChecked = selectedItems.has(`app-${a.id}`);
              return (
                <div
                  key={a.id}
                  onClick={() =>
                    toggleAttachment({
                      type: 'app_window',
                      id: `app-${a.id}`,
                      app: a.name,
                      title: a.windows[0]?.title || a.name,
                    })
                  }
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '8px',
                    padding: '5px 8px',
                    borderRadius: '6px',
                    cursor: 'pointer',
                    fontSize: '13px',
                  }}
                >
                  <input
                    type="checkbox"
                    checked={isChecked}
                    onChange={() => {}}
                    style={{ cursor: 'pointer' }}
                  />
                  <span>💻 {a.name}</span>
                </div>
              );
            })}

            <div style={{ fontSize: '11px', color: '#a1a1aa', padding: '6px 6px 4px', fontWeight: 600 }}>
              Local Files
            </div>
            {filteredHierarchy?.files.map((f) => {
              const isChecked = selectedItems.has(f.id);
              return (
                <div
                  key={f.id}
                  onClick={() =>
                    toggleAttachment({
                      type: 'local_file',
                      id: f.id,
                      name: f.name,
                      path: f.path,
                      isDir: f.isDir,
                    })
                  }
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '8px',
                    padding: '5px 8px',
                    borderRadius: '6px',
                    cursor: 'pointer',
                    fontSize: '13px',
                  }}
                >
                  <input
                    type="checkbox"
                    checked={isChecked}
                    onChange={() => {}}
                    style={{ cursor: 'pointer' }}
                  />
                  <span>📄 {f.name}</span>
                </div>
              );
            })}
          </div>
        )}

        {tier === 'profiles' && selectedBrowser && (
          <div>
            {selectedBrowser.profiles.map((p) => (
              <div
                key={p.id}
                onClick={() => handleProfileClick(p)}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  padding: '8px 10px',
                  borderRadius: '6px',
                  cursor: 'pointer',
                  fontSize: '13px',
                }}
              >
                <span>👤 {p.name}</span>
                <span style={{ fontSize: '11px', color: '#71717a' }}>{p.tabs.length} tabs →</span>
              </div>
            ))}
          </div>
        )}

        {tier === 'tabs' && selectedProfile && (
          <div>
            {selectedProfile.tabs.length === 0 ? (
              <div style={{ padding: '12px', textAlign: 'center', color: '#71717a', fontSize: '12px' }}>
                No open tabs match search
              </div>
            ) : (
              selectedProfile.tabs.map((tab) => {
                const isChecked = selectedItems.has(tab.id);
                return (
                  <div
                    key={tab.id}
                    onClick={() =>
                      toggleAttachment({
                        type: 'browser_tab',
                        id: tab.id,
                        browser: selectedBrowser?.name || 'Browser',
                        profile: selectedProfile.name,
                        title: tab.title,
                        url: tab.url,
                        tabIndex: tab.tabIndex,
                      })
                    }
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: '8px',
                      padding: '6px 8px',
                      borderRadius: '6px',
                      cursor: 'pointer',
                      fontSize: '12px',
                    }}
                  >
                    <input
                      type="checkbox"
                      checked={isChecked}
                      onChange={() => {}}
                      style={{ cursor: 'pointer' }}
                    />
                    <div style={{ overflow: 'hidden' }}>
                      <div
                        style={{
                          fontWeight: 500,
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                        }}
                      >
                        {tab.title}
                      </div>
                      <div
                        style={{
                          fontSize: '10px',
                          color: '#71717a',
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                        }}
                      >
                        {tab.url}
                      </div>
                    </div>
                  </div>
                );
              })
            )}
          </div>
        )}
      </div>

      {selectedItems.size > 0 && (
        <div
          style={{
            padding: '8px 12px',
            borderTop: '1px solid rgba(255, 255, 255, 0.1)',
            backgroundColor: '#202024',
            display: 'flex',
            justifyContent: 'flex-end',
          }}
        >
          <button
            type="button"
            onClick={handleAttachSubmit}
            style={{
              backgroundColor: '#2563eb',
              color: '#fff',
              border: 'none',
              borderRadius: '6px',
              padding: '6px 12px',
              fontSize: '12px',
              fontWeight: 600,
              cursor: 'pointer',
            }}
          >
            Attach Selected ({selectedItems.size})
          </button>
        </div>
      )}
    </div>
  );
}
