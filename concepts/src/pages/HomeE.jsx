// THEME E: Signal — Alert/status-centric, prominent notification states
import React from 'react';
import { Shell } from '../components/Shell.jsx';
import { mockParts, mockQuoteStats, mockActivity } from '../data/mockData.jsx';

export default function HomeSignal() {
  const needsAttention = mockParts.filter(p => p.status === 'failed' || p.status === 'requesting');
  const quotesReady = mockParts.filter(p => p.status === 'received');

  return (
    <Shell theme="e" activePage="home" conceptLetter="E">
      {/* Alert banner */}
      {needsAttention.length > 0 && (
        <div style={{
          background: 'rgba(248,113,113,0.08)',
          border: '1px solid rgba(248,113,113,0.2)',
          borderRadius: 'var(--radius-lg)',
          padding: '14px 18px',
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          marginBottom: 24,
        }}>
          <div style={{ width: 32, height: 32, borderRadius: '50%', background: 'rgba(248,113,113,0.15)', display: 'grid', placeItems: 'center', fontSize: 14, flexShrink: 0 }}>
            !
          </div>
          <div style={{ flex: 1 }}>
            <p style={{ fontSize: 13, fontWeight: 600, color: '#f87171' }}>{needsAttention.length} part{needsAttention.length > 1 ? 's' : ''} need attention</p>
            <p style={{ fontSize: 11, color: 'rgba(248,113,113,0.7)', marginTop: 2 }}>1 quote request stalled · 1 part needs quoting</p>
          </div>
          <button className="btn btn-sm" style={{ background: 'rgba(248,113,113,0.15)', border: '1px solid rgba(248,113,113,0.25)', color: '#f87171', borderRadius: 8 }}>Review</button>
        </div>
      )}

      {/* Status grid */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 14, marginBottom: 28 }}>
        {[
          { label: 'Awaiting quotes', value: mockQuoteStats.requesting, color: '#fb923c', pulse: true },
          { label: 'Quotes ready', value: mockQuoteStats.received, color: '#4ade80', pulse: false },
          { label: 'No request yet', value: mockQuoteStats.notRequested, color: 'rgba(255,255,255,0.25)', pulse: false },
        ].map(s => (
          <div key={s.label} className="stat-card" style={{ position: 'relative', overflow: 'hidden' }}>
            {s.pulse && (
              <div style={{
                position: 'absolute', top: -20, right: -20,
                width: 60, height: 60, borderRadius: '50%',
                background: `${s.color}20`,
                animation: 'pulse 2s ease-in-out infinite',
              }} />
            )}
            <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between' }}>
              <div>
                <div style={{ fontSize: 32, fontWeight: 700, fontFamily: 'var(--font-mono)', color: s.color, lineHeight: 1 }}>{s.value}</div>
                <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4, textTransform: 'uppercase', letterSpacing: '0.08em' }}>{s.label}</div>
              </div>
              <div style={{ width: 10, height: 10, borderRadius: '50%', background: s.color, boxShadow: `0 0 10px ${s.color}80`, marginTop: 4 }} />
            </div>
          </div>
        ))}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 20 }}>
        {/* Quote-ready */}
        <div>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
            <p className="section-label">Quotes ready for review</p>
            <span className="badge badge-accent" style={{ background: 'rgba(74,222,128,0.1)', border: 'rgba(74,222,128,0.25)', color: '#4ade80' }}>
              {quotesReady.length} ready
            </span>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {quotesReady.map(part => (
              <div key={part.id} className="card-sm" style={{ borderLeft: '3px solid #4ade80', cursor: 'pointer' }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
                  <p style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)' }}>{part.name}</p>
                  <span style={{ fontFamily: 'var(--font-mono)', fontSize: 15, fontWeight: 700, color: '#4ade80' }}>{part.quotePrice}</span>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                  <p style={{ fontSize: 11, color: 'var(--text-muted)' }}>{part.vendor} · {part.leadTime} lead</p>
                  <button className="btn btn-sm" style={{ background: 'rgba(74,222,128,0.1)', border: '1px solid rgba(74,222,128,0.2)', color: '#4ade80', borderRadius: 6 }}>Select</button>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Needs attention */}
        <div>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
            <p className="section-label">Needs attention</p>
            <span className="badge badge-danger">{needsAttention.length}</span>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {needsAttention.map(part => (
              <div key={part.id} className="card-sm" style={{
                borderLeft: `3px solid ${part.status === 'failed' ? '#f87171' : '#fb923c'}`,
                cursor: 'pointer',
              }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 }}>
                  <p style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)' }}>{part.name}</p>
                  <span className={`badge badge-${part.status === 'failed' ? 'danger' : 'warning'}`}>
                    {part.status === 'failed' ? 'Failed' : 'Requesting...'}
                  </span>
                </div>
                <p style={{ fontSize: 11, color: 'var(--text-muted)' }}>{part.vendor ?? 'No vendor'} · {part.updatedAt}</p>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Signal alerts log */}
      <div style={{ marginTop: 24 }}>
        <p className="section-label" style={{ marginBottom: 12 }}>Signal log</p>
        <div className="card-inset" style={{ maxHeight: 160, overflow: 'hidden' }}>
          {mockActivity.slice(0, 4).map(act => (
            <div key={act.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 0', borderBottom: '1px solid var(--border-subtle)' }}>
              <div style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--accent)', boxShadow: '0 0 6px var(--accent)', flexShrink: 0 }} />
              <span style={{ fontSize: 12, color: 'var(--text-secondary)', flex: 1 }}>{act.actor} · {act.type.replace('_', ' ')} · {act.part ?? act.detail}</span>
              <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--text-faint)' }}>{act.time}</span>
            </div>
          ))}
        </div>
      </div>
    </Shell>
  );
}
