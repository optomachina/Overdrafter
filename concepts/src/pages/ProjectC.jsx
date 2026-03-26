// THEME C: Atlas — Project as a spatial node graph
import React, { useState } from 'react';
import { Shell } from '../components/Shell.jsx';
import { mockParts } from '../data/mockData.jsx';

const statusColors = { received: '#34d399', requesting: '#fbbf24', failed: '#f87171', not_requested: 'rgba(255,255,255,0.15)' };

export default function ProjectAtlas() {
  const [hovered, setHovered] = useState(null);

  return (
    <Shell theme="c" activePage="projects" conceptLetter="C">
      {/* Breadcrumb */}
      <div className="breadcrumb" style={{ marginBottom: 16 }}>
        <span className="breadcrumb-item">Projects</span>
        <span className="breadcrumb-sep">›</span>
        <span className="breadcrumb-current">FLT Drone Frame Assembly</span>
      </div>

      {/* Spatial canvas */}
      <div style={{
        background: 'var(--surface-card)',
        border: '1px solid var(--border-subtle)',
        borderRadius: 'var(--radius-lg)',
        minHeight: 340,
        marginBottom: 24,
        position: 'relative',
        overflow: 'hidden',
        backgroundImage: 'radial-gradient(circle, rgba(56,189,248,0.05) 1px, transparent 1px)',
        backgroundSize: '24px 24px',
      }}>
        {/* Central project node */}
        <div style={{
          position: 'absolute',
          top: '50%', left: '50%',
          transform: 'translate(-50%, -50%)',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          gap: 6,
        }}>
          <div style={{
            width: 72, height: 72,
            borderRadius: 16,
            background: 'rgba(56,189,248,0.1)',
            border: '2px solid rgba(56,189,248,0.3)',
            display: 'grid',
            placeItems: 'center',
            boxShadow: '0 0 30px rgba(56,189,248,0.15)',
          }}>
            <span style={{ fontSize: 24 }}>◈</span>
          </div>
          <span style={{ fontSize: 11, fontWeight: 600, color: '#38bdf8', fontFamily: 'var(--font-mono)', letterSpacing: '0.05em' }}>PROJECT</span>
          <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)', textAlign: 'center', maxWidth: 100 }}>FLT Drone Frame</span>
          <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>12 parts</span>
        </div>

        {/* Part nodes in orbit */}
        {mockParts.map((part, i) => {
          const angle = (i / mockParts.length) * 2 * Math.PI - Math.PI / 2;
          const radius = 120;
          const cx = 50 + (Math.cos(angle) * radius / 5.5);
          const cy = 50 + (Math.sin(angle) * radius / 3.5);
          const isHovered = hovered === part.id;
          const color = statusColors[part.status];

          return (
            <div
              key={part.id}
              style={{
                position: 'absolute',
                left: `${cx}%`,
                top: `${cy}%`,
                transform: 'translate(-50%, -50%)',
                cursor: 'pointer',
              }}
              onMouseEnter={() => setHovered(part.id)}
              onMouseLeave={() => setHovered(null)}
            >
              <div style={{
                width: isHovered ? 48 : 40,
                height: isHovered ? 48 : 40,
                borderRadius: '50%',
                background: `${color}20`,
                border: `2px solid ${color}`,
                display: 'grid',
                placeItems: 'center',
                fontSize: isHovered ? 13 : 11,
                fontFamily: 'var(--font-mono)',
                fontWeight: 700,
                color: color,
                boxShadow: `0 0 ${isHovered ? 20 : 12}px ${color}50`,
                transition: 'all 0.2s ease',
              }}>
                {part.name.split('-').pop().slice(0, 2)}
              </div>
              {isHovered && (
                <div style={{
                  position: 'absolute',
                  top: '110%', left: '50%',
                  transform: 'translateX(-50%)',
                  background: 'var(--surface-overlay)',
                  border: '1px solid var(--border-default)',
                  borderRadius: 8,
                  padding: '6px 10px',
                  whiteSpace: 'nowrap',
                  zIndex: 10,
                  boxShadow: 'var(--shadow-md)',
                }}>
                  <p style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-primary)' }}>{part.name}</p>
                  <p style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 2 }}>{part.status.replace('_', ' ')} · {part.quotePrice ?? 'No quote'}</p>
                </div>
              )}
            </div>
          );
        })}

        {/* Connection lines from center to each node */}
        <svg style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', pointerEvents: 'none', opacity: 0.1 }}>
          {mockParts.map((part, i) => {
            const angle = (i / mockParts.length) * 2 * Math.PI - Math.PI / 2;
            const radius = 120;
            const cx = 50 + (Math.cos(angle) * radius / 5.5);
            const cy = 50 + (Math.sin(angle) * radius / 3.5);
            return <line key={part.id} x1="50%" y1="50%" x2={`${cx}%`} y2={`${cy}%`} stroke="#38bdf8" strokeWidth="1" />;
          })}
        </svg>
      </div>

      {/* Part list below */}
      <div>
        <p className="section-label" style={{ marginBottom: 12 }}>Parts</p>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 8 }}>
          {mockParts.map(part => {
            const color = statusColors[part.status];
            return (
              <div key={part.id} className="card-sm" style={{ cursor: 'pointer', borderLeft: `3px solid ${color}` }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 }}>
                  <p style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-primary)' }}>{part.name}</p>
                  <div style={{ width: 8, height: 8, borderRadius: '50%', background: color, boxShadow: `0 0 6px ${color}` }} />
                </div>
                <p style={{ fontSize: 10, color: 'var(--text-muted)' }}>{part.material.split(' ')[0]} · {part.qty}pcs</p>
                <p style={{ fontSize: 11, fontFamily: 'var(--font-mono)', color: color, marginTop: 4 }}>{part.quotePrice ?? 'No quote'}</p>
              </div>
            );
          })}
        </div>
      </div>
    </Shell>
  );
}
