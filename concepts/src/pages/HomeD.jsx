// THEME D: Chronicle — Activity-feed-first, editorial storytelling
import React from 'react';
import { Shell } from '../components/Shell.jsx';
import { mockActivity, mockProjects, mockParts, mockQuoteStats } from '../data/mockData.jsx';

const activityIcons = {
  quote_received: { icon: '↓', color: '#34d399', label: 'Quote received' },
  part_uploaded: { icon: '↑', color: '#38bdf8', label: 'Part uploaded' },
  quote_selected: { icon: '✓', color: '#fb923c', label: 'Quote selected' },
  project_created: { icon: '◈', color: '#a78bfa', label: 'Project created' },
  quote_failed: { icon: '!', color: '#f87171', label: 'Quote failed' },
};

export default function HomeChronicle() {
  return (
    <Shell theme="d" activePage="home" conceptLetter="D">
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 320px', gap: 28, maxWidth: 1100 }}>
        {/* Main: activity feed */}
        <div>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20 }}>
            <div>
              <h1 style={{ fontSize: 22, fontWeight: 600, letterSpacing: '-0.02em', color: 'var(--text-primary)' }}>
                Activity
              </h1>
              <p style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 3 }}>Latest events across your workspace</p>
            </div>
            <div className="tab-nav">
              <button className="tab-btn active">All</button>
              <button className="tab-btn">Parts</button>
              <button className="tab-btn">Quotes</button>
            </div>
          </div>

          {/* Timeline */}
          <div style={{ position: 'relative' }}>
            {/* Vertical line */}
            <div style={{ position: 'absolute', left: 15, top: 0, bottom: 0, width: 1, background: 'var(--border-subtle)' }} />

            <div style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
              {mockActivity.map((act, i) => {
                const meta = activityIcons[act.type];
                return (
                  <div key={act.id} style={{ display: 'flex', gap: 16, paddingBottom: 20, position: 'relative' }}>
                    {/* Icon */}
                    <div style={{
                      width: 32, height: 32, borderRadius: '50%',
                      background: `${meta.color}18`,
                      border: `1.5px solid ${meta.color}50`,
                      display: 'grid', placeItems: 'center',
                      fontSize: 13, flexShrink: 0, zIndex: 1,
                      boxShadow: `0 0 0 4px var(--surface-base)`,
                    }}>
                      {meta.icon}
                    </div>

                    {/* Content */}
                    <div style={{ flex: 1, paddingTop: 4 }}>
                      <p style={{ fontSize: 13, color: 'var(--text-primary)', lineHeight: 1.5 }}>
                        <span style={{ fontWeight: 600 }}>{act.actor}</span>
                        {' '}<span style={{ color: 'var(--text-secondary)' }}>{meta.label.toLowerCase()}</span>
                        {act.part && (
                          <span style={{ color: 'var(--accent)' }}> {act.part}</span>
                        )}
                      </p>
                      <p style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>{act.detail}</p>
                      <p style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--text-faint)', marginTop: 4 }}>{act.time}</p>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>

        {/* Sidebar: stats + projects */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
          {/* Quote health */}
          <div className="card">
            <p className="section-label" style={{ marginBottom: 14 }}>Quote status</p>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {Object.entries(mockQuoteStats).map(([key, val]) => (
                <div key={key} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                  <span style={{ fontSize: 12, color: 'var(--text-secondary)', textTransform: 'capitalize' }}>{key.replace(/([A-Z])/g, ' $1').trim()}</span>
                  <span style={{ fontFamily: 'var(--font-mono)', fontSize: 14, fontWeight: 600, color: 'var(--text-primary)' }}>{val}</span>
                </div>
              ))}
            </div>
          </div>

          {/* Projects */}
          <div className="card">
            <p className="section-label" style={{ marginBottom: 12 }}>Projects</p>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {mockProjects.slice(0, 3).map(p => (
                <div key={p.id} style={{ cursor: 'pointer' }}>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 3 }}>
                    <p style={{ fontSize: 12, fontWeight: 500, color: 'var(--text-primary)' }} className="truncate">{p.name}</p>
                    <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>{p.partCount}p</span>
                  </div>
                  <div className="progress-track" style={{ height: 3 }}>
                    <div className="progress-fill" style={{ width: '55%', background: '#fb923c' }} />
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Recent parts */}
          <div className="card">
            <p className="section-label" style={{ marginBottom: 12 }}>Parts needing attention</p>
            {mockParts.filter(p => p.status === 'failed' || p.status === 'not_requested').map(part => (
              <div key={part.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
                <div style={{ minWidth: 0 }}>
                  <p style={{ fontSize: 12, fontWeight: 500, color: 'var(--text-primary)' }} className="truncate">{part.name}</p>
                  <p style={{ fontSize: 10, color: 'var(--text-muted)' }}>{part.status.replace('_', ' ')}</p>
                </div>
                <span className={`badge badge-${part.status === 'failed' ? 'danger' : 'neutral'}`}>{part.status === 'failed' ? '!' : '—'}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </Shell>
  );
}
