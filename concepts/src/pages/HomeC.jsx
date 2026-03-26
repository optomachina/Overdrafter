// THEME C: Atlas — Spatial, immersive, map metaphor
import React from 'react';
import { Shell } from '../components/Shell.jsx';
import { mockProjects, mockParts, mockQuoteStats } from '../data/mockData.jsx';

export default function HomeAtlas() {
  return (
    <Shell theme="c" activePage="home" conceptLetter="C">
      {/* Immersive full-bleed header */}
      <div style={{
        background: 'linear-gradient(135deg, #0c1820 0%, #0f1f2e 100%)',
        borderRadius: 'var(--radius-lg)',
        padding: '36px 32px',
        marginBottom: 24,
        position: 'relative',
        overflow: 'hidden',
        border: '1px solid rgba(56,189,248,0.12)',
      }}>
        {/* Subtle grid pattern */}
        <div style={{
          position: 'absolute', inset: 0, opacity: 0.03,
          backgroundImage: 'linear-gradient(rgba(255,255,255,0.5) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.5) 1px, transparent 1px)',
          backgroundSize: '32px 32px',
        }} />
        <div style={{ position: 'relative', zIndex: 1 }}>
          <p style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'rgba(56,189,248,0.6)', letterSpacing: '0.12em', marginBottom: 10 }}>// WORKSPACE / OVERVIEW</p>
          <h1 style={{ fontSize: 32, fontWeight: 700, letterSpacing: '-0.03em', color: '#fff', lineHeight: 1.1, marginBottom: 12 }}>
            FLT Drone Frame Assembly
          </h1>
          <p style={{ fontSize: 13, color: 'rgba(255,255,255,0.5)', maxWidth: 440, lineHeight: 1.6 }}>
            12 parts · 3 awaiting quotes · 2 quotes ready · Last updated 2h ago
          </p>
          <div style={{ display: 'flex', gap: 8, marginTop: 20 }}>
            <button className="btn btn-primary" style={{ borderRadius: 10 }}>+ Upload parts</button>
            <button className="btn btn-outline" style={{ borderRadius: 10, color: 'rgba(255,255,255,0.7)', borderColor: 'rgba(255,255,255,0.12)' }}>View map</button>
          </div>
        </div>
      </div>

      {/* Status ribbon */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 10, marginBottom: 24 }}>
        {[
          { label: 'Parts', value: '12', icon: '◇', color: '#38bdf8' },
          { label: 'Ready to quote', value: String(mockQuoteStats.notRequested), icon: '◎', color: '#fbbf24' },
          { label: 'Awaiting', value: String(mockQuoteStats.requesting), icon: '◷', color: '#fb923c' },
          { label: 'Quotes in', value: String(mockQuoteStats.received), icon: '✓', color: '#34d399' },
        ].map(s => (
          <div key={s.label} className="card" style={{ padding: '14px 16px', display: 'flex', alignItems: 'center', gap: 12 }}>
            <div style={{ width: 32, height: 32, borderRadius: 8, background: `${s.color}18`, border: `1px solid ${s.color}30`, display: 'grid', placeItems: 'center', fontSize: 14 }}>
              {s.icon}
            </div>
            <div>
              <div style={{ fontSize: 20, fontWeight: 700, fontFamily: 'var(--font-mono)', color: 'var(--text-primary)' }}>{s.value}</div>
              <div style={{ fontSize: 10, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.08em', marginTop: 1 }}>{s.label}</div>
            </div>
          </div>
        ))}
      </div>

      {/* Project map view — spatial representation */}
      <div style={{ marginBottom: 24 }}>
        <p className="section-label" style={{ marginBottom: 10 }}>Project map</p>
        <div style={{
          background: 'var(--surface-card)',
          border: '1px solid var(--border-subtle)',
          borderRadius: 'var(--radius-lg)',
          padding: 20,
          minHeight: 220,
          position: 'relative',
          backgroundImage: 'radial-gradient(circle, rgba(56,189,248,0.06) 1px, transparent 1px)',
          backgroundSize: '28px 28px',
        }}>
          {mockParts.map((part, i) => {
            const positions = [
              { top: '20%', left: '15%' }, { top: '45%', left: '38%' },
              { top: '30%', left: '60%' }, { top: '65%', left: '25%' },
              { top: '55%', left: '58%' },
            ];
            const pos = positions[i] || { top: '50%', left: '50%' };
            const colors = { received: '#34d399', requesting: '#fbbf24', failed: '#f87171', not_requested: 'rgba(255,255,255,0.2)' };
            return (
              <div key={part.id} style={{
                position: 'absolute',
                ...pos,
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                gap: 4,
                cursor: 'pointer',
              }}>
                <div style={{
                  width: 36, height: 36,
                  borderRadius: '50%',
                  background: `${colors[part.status]}18`,
                  border: `2px solid ${colors[part.status]}`,
                  boxShadow: `0 0 12px ${colors[part.status]}40`,
                  display: 'grid',
                  placeItems: 'center',
                  fontSize: 11,
                  fontFamily: 'var(--font-mono)',
                  fontWeight: 600,
                  color: colors[part.status],
                  transition: 'transform 0.2s',
                }}>
                  {part.name.split('-').pop().slice(0, 2)}
                </div>
                <span style={{ fontSize: 9, color: 'var(--text-muted)', fontFamily: 'var(--font-mono)', textAlign: 'center', maxWidth: 56, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {part.name.split('-').slice(-1)[0]}
                </span>
              </div>
            );
          })}
          {/* Connection lines */}
          <svg style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', pointerEvents: 'none', opacity: 0.15 }}>
            <line x1="18%" y1="28%" x2="40%" y2="50%" stroke="#38bdf8" strokeWidth="1" />
            <line x1="42%" y1="50%" x2="63%" y2="35%" stroke="#38bdf8" strokeWidth="1" />
            <line x1="28%" y1="52%" x2="40%" y2="50%" stroke="#38bdf8" strokeWidth="1" />
          </svg>
        </div>
      </div>

      {/* All projects list */}
      <div>
        <p className="section-label" style={{ marginBottom: 10 }}>All projects</p>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: 10 }}>
          {mockProjects.map(p => (
            <div key={p.id} className="card-sm" style={{ cursor: 'pointer' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
                <div style={{ width: 28, height: 28, borderRadius: 8, background: 'rgba(56,189,248,0.1)', border: '1px solid rgba(56,189,248,0.2)', display: 'grid', placeItems: 'center', fontSize: 12, color: '#38bdf8' }}>◈</div>
                <div style={{ minWidth: 0 }}>
                  <p style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)' }} className="truncate">{p.name}</p>
                  <p style={{ fontSize: 10, color: 'var(--text-muted)' }}>{p.partCount} parts · {p.updatedAt}</p>
                </div>
              </div>
              <div className="progress-track">
                <div className="progress-fill" style={{ width: '65%', background: '#38bdf8' }} />
              </div>
            </div>
          ))}
        </div>
      </div>
    </Shell>
  );
}
