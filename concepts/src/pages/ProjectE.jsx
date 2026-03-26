// THEME E: Signal — Health-check-first, alert-driven project view
import React from 'react';
import { Shell } from '../components/Shell.jsx';
import { mockParts, mockQuoteStats } from '../data/mockData.jsx';

export default function ProjectSignal() {
  const failed = mockParts.filter(p => p.status === 'failed');
  const requesting = mockParts.filter(p => p.status === 'requesting');
  const received = mockParts.filter(p => p.status === 'received');

  return (
    <Shell theme="e" activePage="projects" conceptLetter="E">
      {/* Alert for failed */}
      {failed.length > 0 && (
        <div style={{
          background: 'rgba(248,113,113,0.07)',
          border: '1px solid rgba(248,113,113,0.2)',
          borderRadius: 'var(--radius-md)',
          padding: '12px 16px',
          display: 'flex', alignItems: 'center', gap: 12,
          marginBottom: 20,
        }}>
          <div style={{ width: 28, height: 28, borderRadius: '50%', background: 'rgba(248,113,113,0.15)', display: 'grid', placeItems: 'center', fontSize: 13, flexShrink: 0 }}>!</div>
          <div style={{ flex: 1 }}>
            <p style={{ fontSize: 13, fontWeight: 600, color: '#f87171' }}>{failed.length} quote request failed</p>
            <p style={{ fontSize: 11, color: 'rgba(248,113,113,0.6)', marginTop: 1 }}>{failed.map(p => p.name).join(', ')} — retry available</p>
          </div>
          <button className="btn btn-sm" style={{ background: 'rgba(248,113,113,0.12)', border: '1px solid rgba(248,113,113,0.22)', color: '#f87171', borderRadius: 6 }}>Retry</button>
        </div>
      )}

      {/* Health dashboard */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12, marginBottom: 24 }}>
        <div className="stat-card" style={{ borderTop: '3px solid #4ade80' }}>
          <div style={{ fontSize: 28, fontWeight: 700, fontFamily: 'var(--font-mono)', color: '#4ade80' }}>{received.length}</div>
          <div style={{ fontSize: 11, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.08em', marginTop: 4 }}>Quotes received</div>
          <div style={{ marginTop: 8 }}>
            {received.map(p => (
              <div key={p.id} style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
                <span style={{ fontSize: 11, color: 'var(--text-secondary)' }}>{p.name}</span>
                <span style={{ fontSize: 11, fontFamily: 'var(--font-mono)', color: '#4ade80' }}>{p.quotePrice}</span>
              </div>
            ))}
          </div>
        </div>

        <div className="stat-card" style={{ borderTop: '3px solid #fb923c' }}>
          <div style={{ fontSize: 28, fontWeight: 700, fontFamily: 'var(--font-mono)', color: '#fb923c' }}>{requesting.length}</div>
          <div style={{ fontSize: 11, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.08em', marginTop: 4 }}>Awaiting quotes</div>
          <div style={{ marginTop: 8 }}>
            {requesting.map(p => (
              <div key={p.id} style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
                <span style={{ fontSize: 11, color: 'var(--text-secondary)' }}>{p.name}</span>
                <span style={{ fontSize: 11, color: '#fb923c' }}>...</span>
              </div>
            ))}
          </div>
        </div>

        <div className="stat-card" style={{ borderTop: '3px solid rgba(255,255,255,0.15)' }}>
          <div style={{ fontSize: 28, fontWeight: 700, fontFamily: 'var(--font-mono)', color: 'rgba(255,255,255,0.3)' }}>{mockParts.filter(p => p.status === 'not_requested').length}</div>
          <div style={{ fontSize: 11, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.08em', marginTop: 4 }}>Not yet requested</div>
          <button className="btn btn-sm" style={{ marginTop: 10, width: '100%', background: 'rgba(244,114,182,0.1)', border: '1px solid rgba(244,114,182,0.2)', color: '#f472b6', borderRadius: 6 }}>
            Request all
          </button>
        </div>
      </div>

      {/* All parts */}
      <div>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
          <p className="section-label">All parts</p>
          <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>{mockParts.length} total</span>
        </div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Part</th>
                <th>Signal</th>
                <th>Quote</th>
                <th>Vendor</th>
                <th>Action</th>
              </tr>
            </thead>
            <tbody>
              {mockParts.map(part => (
                <tr key={part.id}>
                  <td>
                    <p style={{ fontSize: 13, fontWeight: 500, color: 'var(--text-primary)' }}>{part.name}</p>
                    <p style={{ fontSize: 10, color: 'var(--text-muted)' }}>{part.qty}pcs · {part.material.split(' ')[0]}</p>
                  </td>
                  <td>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <div style={{
                        width: 8, height: 8, borderRadius: '50%',
                        background: part.status === 'received' ? '#4ade80' : part.status === 'requesting' ? '#fb923c' : part.status === 'failed' ? '#f87171' : 'rgba(255,255,255,0.2)',
                        boxShadow: part.status === 'received' ? '0 0 8px #4ade80' : part.status === 'requesting' ? '0 0 8px #fb923c' : 'none',
                      }} />
                      <span style={{ fontSize: 11, color: 'var(--text-secondary)', textTransform: 'capitalize' }}>{part.status.replace('_', ' ')}</span>
                    </div>
                  </td>
                  <td style={{ fontFamily: 'var(--font-mono)', fontSize: 13, fontWeight: 600, color: part.quotePrice ? 'var(--accent)' : 'var(--text-faint)' }}>
                    {part.quotePrice ?? '—'}
                  </td>
                  <td style={{ fontSize: 12, color: 'var(--text-muted)' }}>{part.vendor ?? '—'}</td>
                  <td>
                    {part.status === 'received' && !part.selected && (
                      <button className="btn btn-sm" style={{ background: 'rgba(74,222,128,0.1)', border: '1px solid rgba(74,222,128,0.2)', color: '#4ade80', borderRadius: 6, fontSize: 11, padding: '3px 8px' }}>Select</button>
                    )}
                    {part.status === 'failed' && (
                      <button className="btn btn-sm" style={{ background: 'rgba(248,113,113,0.1)', border: '1px solid rgba(248,113,113,0.2)', color: '#f87171', borderRadius: 6, fontSize: 11, padding: '3px 8px' }}>Retry</button>
                    )}
                    {part.status === 'not_requested' && (
                      <button className="btn btn-sm" style={{ background: 'rgba(244,114,182,0.1)', border: '1px solid rgba(244,114,182,0.2)', color: '#f472b6', borderRadius: 6, fontSize: 11, padding: '3px 8px' }}>Request</button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </Shell>
  );
}
