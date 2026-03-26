// THEME C: Atlas — Immersive CAD viewer, spatial layout, cyan/dark
import React, { useState } from 'react';
import { Shell } from '../components/Shell.jsx';
import { mockPartDetail } from '../data/mockData.jsx';

export default function PartAtlas() {
  const p = mockPartDetail;
  const [activeOffer, setActiveOffer] = useState(p.selectedOffer?.offerId ?? null);
  const [viewMode, setViewMode] = useState('drawing');

  return (
    <Shell theme="c" activePage="parts" conceptLetter="C">
      {/* Full-bleed immersive header */}
      <div style={{
        background: 'linear-gradient(135deg, #0c1820 0%, #111f2e 100%)',
        borderRadius: 'var(--radius-lg)',
        padding: '24px 28px',
        marginBottom: 20,
        border: '1px solid rgba(56,189,248,0.12)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
      }}>
        <div>
          <div className="breadcrumb" style={{ marginBottom: 8 }}>
            <span className="breadcrumb-item" style={{ color: 'rgba(56,189,248,0.6)', fontFamily: 'var(--font-mono)', fontSize: 10 }}>FLT DRONE FRAME</span>
            <span className="breadcrumb-sep">›</span>
            <span className="breadcrumb-current" style={{ fontFamily: 'var(--font-mono)', fontSize: 10 }}>{p.name}</span>
          </div>
          <h1 style={{ fontSize: 24, fontWeight: 700, letterSpacing: '-0.02em', color: '#fff', marginBottom: 4 }}>{p.name}</h1>
          <p style={{ fontSize: 12, color: 'rgba(255,255,255,0.4)' }}>{p.material} · {p.finish} · {p.quantity} pcs</p>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn btn-outline btn-sm" style={{ borderColor: 'rgba(56,189,248,0.2)', color: '#38bdf8', borderRadius: 8 }}>3D view</button>
          <button className="btn btn-primary btn-sm" style={{ borderRadius: 8 }}>Request quote</button>
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 320px', gap: 16 }}>
        {/* Main viewer */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          {/* File viewer */}
          <div style={{
            background: 'var(--surface-card)',
            border: '1px solid var(--border-subtle)',
            borderRadius: 'var(--radius-lg)',
            minHeight: 280,
            position: 'relative',
            overflow: 'hidden',
          }}>
            {/* Mode tabs */}
            <div style={{ display: 'flex', borderBottom: '1px solid var(--border-subtle)', padding: '0 16px' }}>
              {[['Drawing', 'drawing'], ['CAD', 'cad'], ['Compare', 'compare']].map(([label, mode]) => (
                <button key={mode} onClick={() => setViewMode(mode)} style={{
                  padding: '12px 14px',
                  fontSize: 12, fontWeight: 500,
                  color: viewMode === mode ? '#38bdf8' : 'var(--text-muted)',
                  background: 'none',
                  border: 'none',
                  borderBottom: viewMode === mode ? '2px solid #38bdf8' : '2px solid transparent',
                  cursor: 'pointer',
                }}>
                  {label}
                </button>
              ))}
              <div style={{ flex: 1 }} />
              <button style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', fontSize: 12, padding: '0 4px' }}>⊡</button>
            </div>

            {/* Placeholder content */}
            <div style={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center' }}>
              <div style={{ textAlign: 'center', color: 'var(--text-muted)' }}>
                <div style={{ fontSize: 48, marginBottom: 12, opacity: 0.3 }}>{viewMode === 'drawing' ? '📐' : viewMode === 'cad' ? '⬡' : '⇄'}</div>
                <p style={{ fontSize: 13, fontFamily: 'var(--font-mono)' }}>{viewMode === 'drawing' ? p.drawingFile : viewMode === 'cad' ? p.cadFile : 'Quote comparison'}</p>
                <p style={{ fontSize: 11, color: 'var(--text-faint)', marginTop: 4 }}>Click to expand</p>
              </div>
            </div>
          </div>

          {/* Quote cards */}
          <div>
            <p className="section-label" style={{ marginBottom: 10 }}>Vendor options</p>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {/* Selected */}
              <div style={{
                borderRadius: 'var(--radius-md)',
                border: '1.5px solid #38bdf8',
                background: 'rgba(56,189,248,0.05)',
                padding: '14px 16px',
                cursor: 'pointer',
              }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                  <div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                      <span style={{ width: 8, height: 8, borderRadius: '50%', background: '#34d399', boxShadow: '0 0 8px #34d399' }} />
                      <span style={{ fontSize: 13, fontWeight: 600, color: '#38bdf8' }}>{p.selectedOffer.vendor}</span>
                      <span className="badge" style={{ background: 'rgba(56,189,248,0.1)', border: '1px solid rgba(56,189,248,0.2)', color: '#38bdf8', fontSize: 9, padding: '2px 6px' }}>SELECTED</span>
                    </div>
                    <p style={{ fontSize: 11, color: 'var(--text-muted)' }}>{p.selectedOffer.process} · {p.selectedOffer.certifications}</p>
                  </div>
                  <div style={{ textAlign: 'right' }}>
                    <p style={{ fontSize: 20, fontWeight: 700, fontFamily: 'var(--font-mono)', color: '#fff' }}>${p.selectedOffer.price.toLocaleString()}</p>
                    <p style={{ fontSize: 10, color: 'var(--text-muted)' }}>{p.selectedOffer.leadTime} bd</p>
                  </div>
                </div>
              </div>
              {/* Others */}
              {p.otherOffers.map(offer => (
                <div key={offer.vendor} style={{
                  borderRadius: 'var(--radius-md)',
                  border: '1px solid var(--border-subtle)',
                  background: 'var(--surface-card)',
                  padding: '12px 16px',
                  cursor: 'pointer',
                }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                    <div>
                      <p style={{ fontSize: 13, fontWeight: 500, color: 'var(--text-primary)' }}>{offer.vendor}</p>
                      <p style={{ fontSize: 11, color: 'var(--text-muted)' }}>{offer.process} · {offer.certs}</p>
                    </div>
                    <div style={{ textAlign: 'right' }}>
                      <p style={{ fontSize: 18, fontWeight: 600, fontFamily: 'var(--font-mono)', color: 'var(--text-primary)' }}>${offer.price.toLocaleString()}</p>
                      <p style={{ fontSize: 10, color: 'var(--text-muted)' }}>{offer.leadTime} bd</p>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* Right: spec panel */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <p className="section-label" style={{ marginBottom: 4 }}>Part specifications</p>
          <div style={{ borderRadius: 'var(--radius-md)', overflow: 'hidden', border: '1px solid var(--border-subtle)' }}>
            {[['Part no.', p.partNumber], ['Revision', p.rev], ['Material', p.material], ['Finish', p.finish], ['Tolerance', p.tolerance], ['Quantity', p.quantity]].map(([l, v], i, arr) => (
              <div key={l} style={{ display: 'flex', background: i % 2 === 0 ? 'var(--surface-card)' : 'var(--surface-inset)', padding: '9px 12px' }}>
                <span style={{ fontFamily: 'var(--font-mono)', fontSize: 9, textTransform: 'uppercase', letterSpacing: '0.1em', color: 'var(--text-muted)', width: 80, flexShrink: 0 }}>{l}</span>
                <span style={{ fontSize: 12, fontWeight: 500, color: 'var(--text-primary)' }}>{v}</span>
              </div>
            ))}
          </div>

          <div className="card" style={{ padding: '12px 14px' }}>
            <p className="section-label" style={{ marginBottom: 10 }}>Certifications</p>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
              {p.certifications.map(c => (
                <span key={c} style={{ fontSize: 11, padding: '3px 8px', borderRadius: 'var(--radius-full)', background: 'rgba(56,189,248,0.1)', border: '1px solid rgba(56,189,248,0.2)', color: '#38bdf8' }}>{c}</span>
              ))}
            </div>
          </div>

          <div className="card" style={{ padding: '12px 14px' }}>
            <p className="section-label" style={{ marginBottom: 8 }}>Request quote</p>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <input className="input" placeholder="Quantity" type="number" defaultValue={25} />
              <input className="input" type="date" />
              <button className="btn btn-primary" style={{ width: '100%', justifyContent: 'center' }}>Send request</button>
            </div>
          </div>
        </div>
      </div>
    </Shell>
  );
}
