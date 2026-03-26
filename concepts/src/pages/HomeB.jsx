// THEME B: Command — Power-user, keyboard-first, command palette on focus
import React, { useState, useEffect, useRef } from 'react';
import { Shell } from '../components/Shell.jsx';
import { mockProjects, mockParts } from '../data/mockData.jsx';

const ALL_ACTIONS = [
  { group: 'Navigate', items: [
    { title: 'Go to Home', sub: '⌘H' },
    { title: 'Go to Projects', sub: '⌘P' },
    { title: 'Go to All Parts', sub: '⌘A' },
  ]},
  { group: 'Actions', items: [
    { title: 'Upload files', sub: 'U' },
    { title: 'New project', sub: 'N' },
    { title: 'Request quotes', sub: 'R' },
    { title: 'Search parts', sub: '⌘K' },
  ]},
  { group: 'Recent', items: mockProjects.slice(0,3).map(p => ({ title: p.name, sub: `${p.partCount} parts` })) },
];

export default function HomeCommand() {
  const [cmdOpen, setCmdOpen] = useState(false);
  const [query, setQuery] = useState('');
  const inputRef = useRef(null);

  useEffect(() => {
    const onKey = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') { e.preventDefault(); setCmdOpen(true); }
      if (e.key === 'Escape') setCmdOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  useEffect(() => {
    if (cmdOpen) inputRef.current?.focus();
  }, [cmdOpen]);

  const filtered = query
    ? ALL_ACTIONS.map(g => ({
        ...g,
        items: g.items.filter(i => i.title.toLowerCase().includes(query.toLowerCase())),
      })).filter(g => g.items.length > 0)
    : ALL_ACTIONS;

  return (
    <Shell theme="b" activePage="home" conceptLetter="B">
      {/* Minimal chrome: just keyboard hints and a subtle prompt */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 24, maxWidth: 640 }}>
        <div>
          <p style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-muted)', letterSpacing: '0.08em', marginBottom: 8 }}>// workspace / home</p>
          <h1 style={{ fontSize: 28, fontWeight: 600, letterSpacing: '-0.03em', color: 'var(--text-primary)', lineHeight: 1.15 }}>
            Your workspace.
          </h1>
          <p style={{ fontSize: 13, color: 'var(--text-secondary)', marginTop: 8, lineHeight: 1.6 }}>
            Press <kbd style={{ fontFamily: 'var(--font-mono)', fontSize: 11, background: 'var(--surface-inset)', border: '1px solid var(--border-default)', borderRadius: 4, padding: '1px 5px' }}>⌘K</kbd> to search projects, parts, and actions. Start typing to filter.
          </p>
        </div>

        {/* Recent project list — minimal */}
        <div>
          {mockProjects.slice(0, 3).map(p => (
            <div key={p.id} className="sidebar-item" style={{ borderRadius: 'var(--radius-sm)', marginBottom: 2, border: '1px solid var(--border-subtle)' }}>
              <span style={{ opacity: 0.4, fontSize: 12 }}>◈</span>
              <span style={{ fontSize: 13, fontWeight: 500 }}>{p.name}</span>
              <span style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--text-muted)' }}>{p.partCount} parts</span>
            </div>
          ))}
        </div>

        {/* Floating action hints */}
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 8 }}>
          {[['U', 'Upload'], ['N', 'New project'], ['⌘K', 'Search']].map(([key, label]) => (
            <button key={key} className="pill" style={{ fontSize: 11 }}>
              <kbd style={{ fontFamily: 'var(--font-mono)', fontSize: 10, background: 'var(--surface-inset)', border: '1px solid var(--border-default)', borderRadius: 3, padding: '1px 4px' }}>{key}</kbd>
              <span>{label}</span>
            </button>
          ))}
        </div>
      </div>

      {/* Command palette overlay */}
      {cmdOpen && (
        <div className="cmd-overlay" onClick={() => setCmdOpen(false)}>
          <div className="cmd-box" onClick={e => e.stopPropagation()}>
            <div className="cmd-input-row">
              <span style={{ opacity: 0.4, fontSize: 14 }}>⌘</span>
              <input
                ref={inputRef}
                className="cmd-input"
                placeholder="Search projects, parts, actions..."
                value={query}
                onChange={e => setQuery(e.target.value)}
              />
              <button className="btn btn-ghost btn-sm" onClick={() => setCmdOpen(false)} style={{ fontSize: 11, padding: '2px 6px' }}>esc</button>
            </div>
            <div className="cmd-results">
              {filtered.map(group => (
                <div key={group.group}>
                  <p className="cmd-group-label">{group.group}</p>
                  {group.items.map((item, i) => (
                    <div key={i} className="cmd-item">
                      <div className="cmd-item-icon" style={{ fontSize: 11 }}>{item.title[0]}</div>
                      <span className="cmd-item-title">{item.title}</span>
                      <span className="cmd-item-sub">{item.sub}</span>
                    </div>
                  ))}
                </div>
              ))}
            </div>
            <div className="cmd-footer">
              <span className="cmd-kbd"><span className="cmd-kbd-key">↑↓</span> navigate</span>
              <span className="cmd-kbd"><span className="cmd-kbd-key">↵</span> select</span>
              <span className="cmd-kbd"><span className="cmd-kbd-key">esc</span> dismiss</span>
            </div>
          </div>
        </div>
      )}
    </Shell>
  );
}
