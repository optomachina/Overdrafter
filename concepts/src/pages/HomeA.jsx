// THEME A: Precision — Clean refinement of the existing design
// Home page: logged in, no project selected
import React from 'react';
import { Shell } from '../components/Shell.jsx';
import { mockProjects, mockParts, mockQuoteStats, quickActions } from '../data/mockData.jsx';

export default function HomePrecision() {
  return (
    <Shell theme="a" activePage="home" conceptLetter="A">
      {/* Header block */}
      <div style={{ marginBottom: 28 }}>
        <p className="section-label" style={{ marginBottom: 8 }}>// workspace</p>
        <h1 className="page-title">Start with a part package<br />or open an existing project.</h1>
        <p className="page-subtitle" style={{ marginTop: 8, maxWidth: 480 }}>
          Upload files to begin intake. Projects group related parts and stay at the top of the information hierarchy.
        </p>
        <div style={{ display: 'flex', gap: 8, marginTop: 20 }}>
          <button className="btn btn-primary">+ Upload parts &amp; drawings</button>
          <button className="btn btn-outline">Search projects and parts</button>
        </div>
      </div>

      {/* Quick actions */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 28, flexWrap: 'wrap' }}>
        {quickActions.map(a => (
          <button key={a.id} className="pill">
            <span style={{ fontSize: 12 }}>{a.label}</span>
          </button>
        ))}
      </div>

      {/* Stats row */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12, marginBottom: 28 }}>
        {[
          { label: 'Active projects', value: mockProjects.filter(p => p.status === 'active').length },
          { label: 'Parts in workspace', value: mockParts.length },
          { label: 'Quotes received', value: mockQuoteStats.received },
          { label: 'Awaiting response', value: mockQuoteStats.requesting },
        ].map(s => (
          <div key={s.label} className="stat-card">
            <div className="stat-value">{s.value}</div>
            <div className="stat-label">{s.label}</div>
          </div>
        ))}
      </div>

      {/* Recent projects + recent parts */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 20 }}>
        <div>
          <p className="section-label" style={{ marginBottom: 12 }}>Recent projects</p>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {mockProjects.slice(0, 4).map(p => (
              <div key={p.id} className="card-sm" style={{ cursor: 'pointer', borderLeft: '3px solid rgba(52,211,153,0.3)' }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                  <div>
                    <p style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)' }}>{p.name}</p>
                    <p style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>{p.partCount} parts · {p.updatedAt}</p>
                  </div>
                  <span className="badge badge-neutral">{p.status}</span>
                </div>
              </div>
            ))}
          </div>
        </div>

        <div>
          <p className="section-label" style={{ marginBottom: 12 }}>Recent parts</p>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {mockParts.slice(0, 5).map(part => (
              <div key={part.id} className="card-sm" style={{ cursor: 'pointer', borderLeft: `3px solid ${part.status === 'received' ? 'rgba(52,211,153,0.4)' : part.status === 'requesting' ? 'rgba(251,191,36,0.4)' : 'rgba(255,255,255,0.08)'}` }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                  <div style={{ minWidth: 0 }}>
                    <p style={{ fontSize: 13, fontWeight: 500, color: 'var(--text-primary)' }} className="truncate">{part.name}</p>
                    <p style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }} className="truncate">{part.description}</p>
                  </div>
                  <span className={`badge badge-${part.status === 'received' ? 'accent' : part.status === 'requesting' ? 'warning' : 'neutral'}`}>
                    {part.status === 'received' ? `✓ ${part.quotePrice}` : part.status === 'requesting' ? '...' : '—'}
                  </span>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </Shell>
  );
}
