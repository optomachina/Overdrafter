// THEME D: Chronicle — Document/story-centric, version history first
import React, { useState } from 'react';
import { Shell } from '../components/Shell.jsx';
import { mockPartDetail } from '../data/mockData.jsx';

export default function PartChronicle() {
  const p = mockPartDetail;

  return (
    <Shell theme="d" activePage="parts" conceptLetter="D">
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 260px', gap: 28 }}>
        {/* Main */}
        <div>
          {/* Article-style header */}
          <div style={{ marginBottom: 24 }}>
            <p className="section-label" style={{ marginBottom: 8 }}>// Part record</p>
            <h1 style={{ fontSize: 26, fontWeight: 700, letterSpacing: '-0.025em', color: 'var(--text-primary)', lineHeight: 1.2, marginBottom: 10 }}>
              {p.name}
            </h1>
            <p style={{ fontSize: 14, color: 'var(--text-secondary)', lineHeight: 1.7, maxWidth: 520 }}>
              {p.description}. This part is sourced in {p.material} with a {p.finish} finish per drawing {p.drawingFile}, revision {p.rev}. A quote package has been received and a selection recorded with {p.selectedOffer.vendor}.
            </p>
          </div>

          {/* Spec block */}
          <div className="card" style={{ marginBottom: 20 }}>
            <p className="section-label" style={{ marginBottom: 14 }}>Technical specifications</p>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
              {[
                ['Part number', p.partNumber],
                ['Revision', p.rev],
                ['Material', p.material],
                ['Finish', p.finish],
                ['Tolerance', p.tolerance],
                ['Quantity', `${p.quantity} pcs`],
                ['Project', p.project],
                ['Created', p.created],
              ].map(([l, v]) => (
                <div key={l}>
                  <p style={{ fontFamily: 'var(--font-mono)', fontSize: 9, textTransform: 'uppercase', letterSpacing: '0.12em', color: 'var(--text-muted)', marginBottom: 4 }}>{l}</p>
                  <p style={{ fontSize: 13, fontWeight: 500, color: 'var(--text-primary)' }}>{v}</p>
                </div>
              ))}
            </div>
          </div>

          {/* Quote narrative */}
          <div className="card">
            <p className="section-label" style={{ marginBottom: 14 }}>Quote decision</p>
            <div style={{
              background: 'rgba(251,146,60,0.06)',
              border: '1px solid rgba(251,146,60,0.15)',
              borderRadius: 'var(--radius-md)',
              padding: '16px',
              marginBottom: 14,
            }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                <div>
                  <p style={{ fontSize: 15, fontWeight: 600, color: 'var(--text-primary)', marginBottom: 4 }}>{p.selectedOffer.vendor} selected</p>
                  <p style={{ fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.6 }}>
                    {p.selectedOffer.process} — {p.selectedOffer.certifications} certified. Lead time of {p.selectedOffer.leadTime} business days was the fastest available option with the required certifications.
                  </p>
                </div>
                <div style={{ textAlign: 'right', flexShrink: 0, marginLeft: 16 }}>
                  <p style={{ fontSize: 24, fontWeight: 700, fontFamily: 'var(--font-mono)', color: '#fb923c' }}>${p.selectedOffer.price.toLocaleString()}</p>
                  <p style={{ fontSize: 11, color: 'var(--text-muted)' }}>{p.selectedOffer.leadTime} bd</p>
                </div>
              </div>
            </div>

            <p style={{ fontFamily: 'var(--font-mono)', fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.1em', color: 'var(--text-muted)', marginBottom: 10 }}>Other options</p>
            {p.otherOffers.map(offer => (
              <div key={offer.vendor} style={{ display: 'flex', justifyContent: 'space-between', padding: '10px 0', borderBottom: '1px solid var(--border-subtle)' }}>
                <div>
                  <p style={{ fontSize: 13, fontWeight: 500, color: 'var(--text-primary)' }}>{offer.vendor}</p>
                  <p style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>{offer.process} · {offer.certs}</p>
                </div>
                <div style={{ textAlign: 'right' }}>
                  <p style={{ fontSize: 15, fontWeight: 600, fontFamily: 'var(--font-mono)', color: 'var(--text-primary)' }}>${offer.price.toLocaleString()}</p>
                  <p style={{ fontSize: 10, color: 'var(--text-muted)' }}>{offer.leadTime} bd</p>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Sidebar */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
          {/* Version history */}
          <div className="card">
            <p className="section-label" style={{ marginBottom: 14 }}>Version history</p>
            <div>
              {[
                { version: 'Rev C', date: 'Mar 22, 2026', note: 'Tolerance updated to ±0.005 in' },
                { version: 'Rev B', date: 'Mar 18, 2026', note: 'Material changed to 6061-T6' },
                { version: 'Rev A', date: 'Mar 12, 2026', note: 'Initial drawing released' },
              ].map((v, i) => (
                <div key={v.version} style={{ display: 'flex', gap: 10, marginBottom: 12 }}>
                  <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 0 }}>
                    <div style={{ width: 8, height: 8, borderRadius: '50%', background: i === 0 ? '#fb923c' : 'var(--border-default)', flexShrink: 0 }} />
                    {i < 2 && <div style={{ width: 1, flex: 1, background: 'var(--border-subtle)', minHeight: 16 }} />}
                  </div>
                  <div>
                    <p style={{ fontSize: 12, fontWeight: 600, color: i === 0 ? '#fb923c' : 'var(--text-primary)' }}>{v.version}</p>
                    <p style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 1 }}>{v.date}</p>
                    <p style={{ fontSize: 11, color: 'var(--text-secondary)', marginTop: 2, lineHeight: 1.5 }}>{v.note}</p>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Attached files */}
          <div className="card">
            <p className="section-label" style={{ marginBottom: 12 }}>Attached files</p>
            {[
              { name: p.drawingFile, type: 'PDF Drawing', size: '0.3 MB' },
              { name: p.cadFile, type: 'STEP CAD', size: '1.4 MB' },
            ].map(f => (
              <div key={f.name} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 0', borderBottom: '1px solid var(--border-subtle)' }}>
                <div style={{ width: 28, height: 28, borderRadius: 6, background: 'rgba(251,146,60,0.08)', border: '1px solid rgba(251,146,60,0.15)', display: 'grid', placeItems: 'center', fontSize: 11, color: '#fb923c' }}>
                  {f.type.split(' ')[0][0]}
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <p style={{ fontSize: 12, color: 'var(--text-primary)' }} className="truncate">{f.name}</p>
                  <p style={{ fontSize: 10, color: 'var(--text-muted)' }}>{f.type} · {f.size}</p>
                </div>
              </div>
            ))}
          </div>

          {/* Certifications */}
          <div className="card">
            <p className="section-label" style={{ marginBottom: 10 }}>Certifications</p>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {p.certifications.map(cert => (
                <div key={cert} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ width: 6, height: 6, borderRadius: '50%', background: '#fb923c)' }} />
                  <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>{cert}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </Shell>
  );
}
