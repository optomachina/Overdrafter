// THEME A: Precision — Full part detail with tabs + inspector
import React, { useState } from 'react';
import { Shell } from '../components/Shell.jsx';
import { mockPartDetail } from '../data/mockData.jsx';

const TABS = ['Overview', 'Quotes', 'Activity'];

export default function PartPrecision() {
  const [tab, setTab] = useState('Overview');
  const [qty, setQty] = useState(25);
  const p = mockPartDetail;

  return (
    <Shell theme="a" activePage="parts" conceptLetter="A">
      {/* Breadcrumb */}
      <div className="breadcrumb" style={{ marginBottom: 16 }}>
        <span className="breadcrumb-item">Projects</span>
        <span className="breadcrumb-sep">›</span>
        <span className="breadcrumb-item">FLT Drone Frame</span>
        <span className="breadcrumb-sep">›</span>
        <span className="breadcrumb-current">{p.name}</span>
      </div>

      <div style={{ display: 'flex', gap: 20 }}>
        {/* Main content */}
        <div style={{ flex: 1, minWidth: 0 }}>
          {/* Header */}
          <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 20 }}>
            <div>
              <h1 style={{ fontSize: 22, fontWeight: 700, letterSpacing: '-0.02em', color: 'var(--text-primary)' }}>{p.name}</h1>
              <p style={{ fontSize: 13, color: 'var(--text-muted)', marginTop: 4 }}>{p.description}</p>
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <button className="btn btn-outline btn-sm">Copy link</button>
              <button className="btn btn-primary btn-sm">Request quote</button>
            </div>
          </div>

          {/* Tab nav */}
          <div className="tab-nav" style={{ marginBottom: 20 }}>
            {TABS.map(t => <button key={t} className={`tab-btn${tab === t ? ' active' : ''}`} onClick={() => setTab(t)}>{t}</button>)}
          </div>

          {/* Overview tab */}
          {tab === 'Overview' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
              {/* File previews */}
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                <div className="card-inset" style={{ minHeight: 180, display: 'grid', placeItems: 'center', color: 'var(--text-muted)', fontSize: 12, cursor: 'pointer' }}>
                  <div style={{ textAlign: 'center' }}>
                    <div style={{ fontSize: 28, marginBottom: 6 }}>📐</div>
                    <p>{p.drawingFile}</p>
                    <p style={{ fontSize: 10, color: 'var(--text-faint)', marginTop: 2 }}>Click to expand</p>
                  </div>
                </div>
                <div className="card-inset" style={{ minHeight: 180, display: 'grid', placeItems: 'center', color: 'var(--text-muted)', fontSize: 12, cursor: 'pointer' }}>
                  <div style={{ textAlign: 'center' }}>
                    <div style={{ fontSize: 28, marginBottom: 6 }}>⬡</div>
                    <p>{p.cadFile}</p>
                    <p style={{ fontSize: 10, color: 'var(--text-faint)', marginTop: 2 }}>STEP · Click to expand</p>
                  </div>
                </div>
              </div>

              {/* Specs + form */}
              <div className="card">
                <p className="section-label" style={{ marginBottom: 14 }}>Request details</p>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
                  <div>
                    <label style={{ fontSize: 11, color: 'var(--text-muted)', display: 'block', marginBottom: 4 }}>Quantity</label>
                    <input className="input" type="number" value={qty} onChange={e => setQty(Number(e.target.value))} style={{ width: 100 }} />
                  </div>
                  <div>
                    <label style={{ fontSize: 11, color: 'var(--text-muted)', display: 'block', marginBottom: 4 }}>Due date</label>
                    <input className="input" type="date" style={{ width: 140 }} />
                  </div>
                </div>
              </div>

              {/* Selected offer */}
              {p.selectedOffer && (
                <div className="card" style={{ borderLeft: '3px solid var(--accent)' }}>
                  <p className="section-label" style={{ marginBottom: 12 }}>Selected quote</p>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                    <div>
                      <p style={{ fontSize: 15, fontWeight: 600, color: 'var(--text-primary)' }}>{p.selectedOffer.vendor}</p>
                      <p style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 2 }}>{p.selectedOffer.process} · {p.selectedOffer.certifications}</p>
                    </div>
                    <div style={{ textAlign: 'right' }}>
                      <p style={{ fontSize: 22, fontWeight: 700, fontFamily: 'var(--font-mono)', color: 'var(--accent)' }}>${p.selectedOffer.price.toLocaleString()}</p>
                      <p style={{ fontSize: 11, color: 'var(--text-muted)' }}>{p.selectedOffer.leadTime} business days</p>
                    </div>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Quotes tab */}
          {tab === 'Quotes' && (
            <div className="card">
              <p className="section-label" style={{ marginBottom: 14 }}>Vendor options</p>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 14px', borderRadius: 'var(--radius-md)', border: '1px solid var(--accent-border)', background: 'var(--accent-dim)' }}>
                  <div>
                    <p style={{ fontSize: 13, fontWeight: 600, color: 'var(--accent)' }}>✓ {p.selectedOffer.vendor}</p>
                    <p style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>{p.selectedOffer.process} · {p.selectedOffer.certifications}</p>
                  </div>
                  <div style={{ textAlign: 'right' }}>
                    <p style={{ fontSize: 16, fontWeight: 700, fontFamily: 'var(--font-mono)', color: 'var(--accent)' }}>${p.selectedOffer.price.toLocaleString()}</p>
                    <p style={{ fontSize: 11, color: 'var(--text-muted)' }}>{p.selectedOffer.leadTime} bd</p>
                  </div>
                </div>
                {p.otherOffers.map(offer => (
                  <div key={offer.vendor} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 14px', borderRadius: 'var(--radius-md)', border: '1px solid var(--border-subtle)', background: 'var(--surface-inset)' }}>
                    <div>
                      <p style={{ fontSize: 13, fontWeight: 500, color: 'var(--text-primary)' }}>{offer.vendor}</p>
                      <p style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>{offer.process} · {offer.certs}</p>
                    </div>
                    <div style={{ textAlign: 'right' }}>
                      <p style={{ fontSize: 16, fontWeight: 700, fontFamily: 'var(--font-mono)', color: 'var(--text-primary)' }}>${offer.price.toLocaleString()}</p>
                      <p style={{ fontSize: 11, color: 'var(--text-muted)' }}>{offer.leadTime} bd</p>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Right panel: part specs */}
        <div style={{ width: 260, flexShrink: 0 }}>
          <p className="section-label" style={{ marginBottom: 12 }}>Part specs</p>
          <div className="prop-grid" style={{ marginBottom: 14 }}>
            {[['Part no.', p.partNumber], ['Revision', p.rev], ['Material', p.material], ['Finish', p.finish], ['Tolerance', p.tolerance], ['Quantity', p.quantity]].map(([l, v]) => (
              <div key={l} className="prop-cell">
                <div className="prop-label">{l}</div>
                <div className="prop-value mono" style={{ fontSize: 11 }}>{v}</div>
              </div>
            ))}
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {p.certifications.map(cert => (
              <span key={cert} className="badge badge-info" style={{ alignSelf: 'flex-start' }}>{cert}</span>
            ))}
          </div>

          <div className="divider" />

          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12 }}>
              <span style={{ color: 'var(--text-muted)' }}>Created</span>
              <span style={{ color: 'var(--text-secondary)' }}>{p.created}</span>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12 }}>
              <span style={{ color: 'var(--text-muted)' }}>Project</span>
              <span style={{ color: 'var(--text-secondary)' }}>{p.project}</span>
            </div>
          </div>
        </div>
      </div>
    </Shell>
  );
}
