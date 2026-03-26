// THEME E: Signal — Quote-first, prominent status signals
import React, { useState } from 'react';
import { Shell } from '../components/Shell.jsx';
import { mockPartDetail } from '../data/mockData.jsx';

export default function PartSignal() {
  const p = mockPartDetail;

  return (
    <Shell theme="e" activePage="parts" conceptLetter="E">
      {/* Signal status banner */}
      <div style={{
        background: 'rgba(74,222,128,0.07)',
        border: '1px solid rgba(74,222,128,0.2)',
        borderRadius: 'var(--radius-lg)',
        padding: '16px 20px',
        display: 'flex',
        alignItems: 'center',
        gap: 16,
        marginBottom: 24,
      }}>
        <div style={{ width: 44, height: 44, borderRadius: '50%', background: 'rgba(74,222,128,0.15)', display: 'grid', placeItems: 'center', flexShrink: 0 }}>
          <span style={{ fontSize: 20 }}>✓</span>
        </div>
        <div style={{ flex: 1 }}>
          <p style={{ fontSize: 15, fontWeight: 700, color: '#4ade80', marginBottom: 2 }}>Quote selected — {p.selectedOffer.vendor}</p>
          <p style={{ fontSize: 12, color: 'rgba(74,222,128,0.6)' }}>Selection recorded. Your order is ready for handoff.</p>
        </div>
        <div style={{ textAlign: 'right', flexShrink: 0 }}>
          <p style={{ fontSize: 26, fontWeight: 700, fontFamily: 'var(--font-mono)', color: '#4ade80' }}>${p.selectedOffer.price.toLocaleString()}</p>
          <p style={{ fontSize: 11, color: 'rgba(74,222,128,0.6)' }}>{p.selectedOffer.leadTime} business days</p>
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 300px', gap: 20 }}>
        {/* Left: signal panel */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          {/* Specs */}
          <div className="card" style={{ padding: '16px 18px' }}>
            <p className="section-label" style={{ marginBottom: 14 }}>Part signal</p>
            <div className="prop-grid">
              {[['Part no.', p.partNumber], ['Rev', p.rev], ['Material', p.material], ['Finish', p.finish], ['Tolerance', p.tolerance], ['Qty', `${p.quantity} pcs`]].map(([l, v]) => (
                <div key={l} className="prop-cell">
                  <div className="prop-label">{l}</div>
                  <div className="prop-value mono">{v}</div>
                </div>
              ))}
            </div>
          </div>

          {/* Vendor options signal comparison */}
          <div>
            <p className="section-label" style={{ marginBottom: 12 }}>All options</p>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <div style={{
                borderRadius: 'var(--radius-md)',
                border: '2px solid #4ade80',
                background: 'rgba(74,222,128,0.05)',
                padding: '14px 16px',
              }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                    <div style={{ width: 10, height: 10, borderRadius: '50%', background: '#4ade80', boxShadow: '0 0 10px #4ade80' }} />
                    <div>
                      <p style={{ fontSize: 14, fontWeight: 700, color: '#4ade80' }}>{p.selectedOffer.vendor}</p>
                      <p style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 1 }}>{p.selectedOffer.process} · {p.selectedOffer.certifications}</p>
                    </div>
                  </div>
                  <div style={{ textAlign: 'right' }}>
                    <p style={{ fontSize: 20, fontWeight: 700, fontFamily: 'var(--font-mono)', color: '#4ade80' }}>${p.selectedOffer.price.toLocaleString()}</p>
                    <p style={{ fontSize: 11, color: 'var(--text-muted)' }}>{p.selectedOffer.leadTime} bd</p>
                  </div>
                </div>
                <div style={{ marginTop: 10, paddingTop: 10, borderTop: '1px solid rgba(74,222,128,0.15)' }}>
                  <span className="badge" style={{ background: 'rgba(74,222,128,0.1)', border: '1px solid rgba(74,222,128,0.2)', color: '#4ade80', fontSize: 10 }}>SELECTED</span>
                </div>
              </div>

              {p.otherOffers.map((offer, i) => (
                <div key={offer.vendor} style={{
                  borderRadius: 'var(--radius-md)',
                  border: '1px solid var(--border-subtle)',
                  background: 'var(--surface-card)',
                  padding: '12px 14px',
                }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                      <div style={{ width: 8, height: 8, borderRadius: '50%', background: 'rgba(244,114,182,0.4)' }} />
                      <div>
                        <p style={{ fontSize: 13, fontWeight: 500, color: 'var(--text-primary)' }}>{offer.vendor}</p>
                        <p style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 1 }}>{offer.process} · {offer.certs}</p>
                      </div>
                    </div>
                    <div style={{ textAlign: 'right' }}>
                      <p style={{ fontSize: 16, fontWeight: 600, fontFamily: 'var(--font-mono)', color: 'var(--text-primary)' }}>${offer.price.toLocaleString()}</p>
                      <p style={{ fontSize: 11, color: 'var(--text-muted)' }}>{offer.leadTime} bd</p>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* File signals */}
          <div className="card" style={{ padding: '14px 16px' }}>
            <p className="section-label" style={{ marginBottom: 12 }}>File signals</p>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
              <div style={{ background: 'rgba(244,114,182,0.06)', border: '1px solid rgba(244,114,182,0.15)', borderRadius: 'var(--radius-md)', padding: '10px 12px', cursor: 'pointer' }}>
                <p style={{ fontSize: 11, color: '#f472b6', fontWeight: 600, marginBottom: 4 }}>Drawing</p>
                <p style={{ fontSize: 11, color: 'var(--text-muted)' }}>{p.drawingFile}</p>
                <p style={{ fontSize: 10, color: '#4ade80', marginTop: 4, fontFamily: 'var(--font-mono)' }}>✓ Extracted</p>
              </div>
              <div style={{ background: 'rgba(244,114,182,0.06)', border: '1px solid rgba(244,114,182,0.15)', borderRadius: 'var(--radius-md)', padding: '10px 12px', cursor: 'pointer' }}>
                <p style={{ fontSize: 11, color: '#f472b6', fontWeight: 600, marginBottom: 4 }}>CAD</p>
                <p style={{ fontSize: 11, color: 'var(--text-muted)' }}>{p.cadFile}</p>
                <p style={{ fontSize: 10, color: '#4ade80', marginTop: 4, fontFamily: 'var(--font-mono)' }}>✓ Matched</p>
              </div>
            </div>
          </div>
        </div>

        {/* Right: actions */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <p className="section-label" style={{ marginBottom: 4 }}>Actions</p>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {[
              { label: 'Download quote package', icon: '↓', color: '#4ade80' },
              { label: 'Download drawings', icon: '↓', color: '#38bdf8' },
              { label: 'Request revision', icon: '↺', color: '#fb923c' },
              { label: 'Archive part', icon: '◐', color: 'rgba(255,255,255,0.3)' },
            ].map(a => (
              <button key={a.label} className="btn btn-outline" style={{ justifyContent: 'flex-start', borderColor: 'var(--border-subtle)', color: 'var(--text-secondary)' }}>
                <span style={{ fontSize: 14, color: a.color }}>{a.icon}</span>
                {a.label}
              </button>
            ))}
          </div>

          <div className="divider" />

          {/* Metadata */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {[['Created', p.created], ['Project', p.project]].map(([l, v]) => (
              <div key={l} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12 }}>
                <span style={{ color: 'var(--text-muted)' }}>{l}</span>
                <span style={{ color: 'var(--text-secondary)' }}>{v}</span>
              </div>
            ))}
          </div>

          <div className="card" style={{ padding: '10px 12px' }}>
            <p style={{ fontSize: 10, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 8 }}>Certifications</p>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
              {p.certifications.map(c => (
                <span key={c} style={{ fontSize: 10, padding: '2px 7px', borderRadius: 'var(--radius-full)', background: 'rgba(244,114,182,0.08)', border: '1px solid rgba(244,114,182,0.15)', color: '#f472b6' }}>{c}</span>
              ))}
            </div>
          </div>
        </div>
      </div>
    </Shell>
  );
}
