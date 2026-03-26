// THEME A: Precision — Project ledger with side inspector
import React, { useState } from 'react';
import { Shell } from '../components/Shell.jsx';
import { mockParts, mockPartDetail } from '../data/mockData.jsx';

const FILTERS = ['All', 'Received', 'Requesting', 'Not requested', 'Failed'];
const [activeFilter, setActiveFilter] = useState('All');

export default function ProjectPrecision() {
  const [selectedPart, setSelectedPart] = useState(mockParts[0]);
  const [filter, setFilter] = useState('All');

  const filtered = filter === 'All' ? mockParts : mockParts.filter(p =>
    filter === 'Received' ? p.status === 'received' :
    filter === 'Requesting' ? p.status === 'requesting' :
    filter === 'Not requested' ? p.status === 'not_requested' :
    p.status === 'failed'
  );

  return (
    <Shell theme="a" activePage="projects" conceptLetter="A">
      <div style={{ display: 'flex', gap: 0, height: '100%' }}>
        {/* Main: parts table */}
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
          {/* Project header */}
          <div style={{ marginBottom: 20 }}>
            <div className="breadcrumb" style={{ marginBottom: 8 }}>
              <span className="breadcrumb-item">Projects</span>
              <span className="breadcrumb-sep">›</span>
              <span className="breadcrumb-current">FLT Drone Frame Assembly</span>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <h1 className="page-title">FLT Drone Frame Assembly</h1>
              <div style={{ display: 'flex', gap: 8 }}>
                <button className="btn btn-outline btn-sm">+ Add part</button>
                <button className="btn btn-primary btn-sm">Request quotes</button>
              </div>
            </div>
            <div style={{ display: 'flex', gap: 16, marginTop: 10 }}>
              {[['12 parts', '#38bdf8'], ['2 quotes ready', '#34d399'], ['1 awaiting', '#fbbf24']].map(([label, color]) => (
                <span key={label} style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 12, color: 'var(--text-secondary)' }}>
                  <span style={{ width: 6, height: 6, borderRadius: '50%', background: color }} />
                  {label}
                </span>
              ))}
            </div>
          </div>

          {/* Filter tabs */}
          <div className="tab-nav" style={{ marginBottom: 16, alignSelf: 'flex-start' }}>
            {FILTERS.map(f => (
              <button key={f} className={`tab-btn${filter === f ? ' active' : ''}`} onClick={() => setFilter(f)}>{f}</button>
            ))}
          </div>

          {/* Parts table */}
          <div className="table-wrap" style={{ flex: 1 }}>
            <table>
              <thead>
                <tr>
                  <th>Part</th>
                  <th>Rev</th>
                  <th>Material</th>
                  <th>Qty</th>
                  <th>Quote</th>
                  <th>Lead time</th>
                  <th>Vendor</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map(part => (
                  <tr
                    key={part.id}
                    className={selectedPart?.id === part.id ? 'selected' : ''}
                    onClick={() => setSelectedPart(part)}
                  >
                    <td className="primary">{part.name}</td>
                    <td style={{ fontFamily: 'var(--font-mono)', fontSize: 12 }}>{part.rev}</td>
                    <td style={{ fontSize: 12 }}>{part.material.split(' ')[0]}</td>
                    <td style={{ fontFamily: 'var(--font-mono)', fontSize: 12 }}>{part.qty}</td>
                    <td style={{ fontFamily: 'var(--font-mono)', fontSize: 12, fontWeight: 600, color: part.quotePrice ? 'var(--accent)' : 'var(--text-muted)' }}>
                      {part.quotePrice ?? '—'}
                    </td>
                    <td style={{ fontFamily: 'var(--font-mono)', fontSize: 12 }}>{part.leadTime ?? '—'}</td>
                    <td style={{ fontSize: 12 }}>{part.vendor ?? '—'}</td>
                    <td>
                      <span className={`badge badge-${part.status === 'received' ? 'accent' : part.status === 'requesting' ? 'warning' : part.status === 'failed' ? 'danger' : 'neutral'}`}>
                        {part.status === 'received' ? '✓ Received' : part.status === 'requesting' ? '... Requesting' : part.status === 'failed' ? '! Failed' : '—'}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        {/* Inspector panel */}
        <div style={{
          width: 300,
          flexShrink: 0,
          borderLeft: '1px solid var(--border-subtle)',
          paddingLeft: 20,
          paddingRight: 4,
          overflowY: 'auto',
        }}>
          <p className="section-label" style={{ marginBottom: 12 }}>Inspector</p>
          {selectedPart && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
              <div>
                <p style={{ fontSize: 15, fontWeight: 600, color: 'var(--text-primary)' }}>{selectedPart.name}</p>
                <p style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 3 }}>{selectedPart.description}</p>
              </div>

              <div className="prop-grid">
                {[['Part no.', selectedPart.name], ['Rev', selectedPart.rev], ['Material', selectedPart.material], ['Finish', selectedPart.finish], ['Qty', selectedPart.qty], ['Status', selectedPart.status]].
                  map(([l, v]) => (
                    <div key={l} className="prop-cell">
                      <div className="prop-label">{l}</div>
                      <div className="prop-value mono">{v}</div>
                    </div>
                  ))}
              </div>

              {selectedPart.status === 'received' && (
                <div className="card" style={{ borderLeft: '3px solid var(--accent)', padding: '12px 14px' }}>
                  <p className="section-label" style={{ marginBottom: 6 }}>Selected quote</p>
                  <p style={{ fontSize: 18, fontWeight: 700, fontFamily: 'var(--font-mono)', color: 'var(--accent)' }}>{selectedPart.quotePrice}</p>
                  <p style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>{selectedPart.vendor} · {selectedPart.leadTime}</p>
                </div>
              )}

              <div className="card-inset" style={{ minHeight: 120, display: 'grid', placeItems: 'center', color: 'var(--text-muted)', fontSize: 11 }}>
                CAD preview
              </div>
              <div className="card-inset" style={{ minHeight: 80, display: 'grid', placeItems: 'center', color: 'var(--text-muted)', fontSize: 11 }}>
                Drawing preview
              </div>
            </div>
          )}
        </div>
      </div>
    </Shell>
  );
}
