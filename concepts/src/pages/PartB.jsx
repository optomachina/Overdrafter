// THEME B: Command — Dense, keyboard-driven, minimal chrome
import React, { useState } from 'react';
import { Shell } from '../components/Shell.jsx';
import { mockPartDetail } from '../data/mockData.jsx';

export default function PartCommand() {
  const p = mockPartDetail;

  return (
    <Shell theme="b" activePage="parts" conceptLetter="B">
      <div style={{ display: 'flex', flexDirection: 'column', gap: 0, maxWidth: 900 }}>
        {/* Minimal header */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20, paddingBottom: 16, borderBottom: '1px solid var(--border-subtle)' }}>
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
              <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--text-muted)', letterSpacing: '0.06em' }}>{p.partNumber}</span>
              <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--text-faint)' }}>·</span>
              <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--accent)', letterSpacing: '0.04em' }}>{p.rev}</span>
            </div>
            <h1 style={{ fontSize: 18, fontWeight: 600, letterSpacing: '-0.02em', color: 'var(--text-primary)' }}>{p.name}</h1>
          </div>
          <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            {[['F', 'pin'], ['R', 'request'], ['⌘K', 'search']].map(([k, l]) => (
              <span key={k} style={{ display: 'flex', alignItems: 'center', gap: 3, fontSize: 10, color: 'var(--text-muted)' }}>
                <kbd style={{ fontFamily: 'var(--font-mono)', fontSize: 9, background: 'var(--surface-inset)', border: '1px solid var(--border-default)', borderRadius: 3, padding: '1px 4px' }}>{k}</kbd>
                <span>{l}</span>
              </span>
            ))}
          </div>
        </div>

        {/* Specs grid */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 1, borderRadius: 'var(--radius-sm)', overflow: 'hidden', border: '1px solid var(--border-subtle)', marginBottom: 16 }}>
          {[['Part no.', p.partNumber], ['Rev', p.rev], ['Material', p.material], ['Finish', p.finish], ['Tolerance', p.tolerance], ['Qty', p.quantity], ['Project', p.project], ['Certifications', p.certifications.join(', ')]].map(([l, v]) => (
            <div key={l} style={{ background: 'var(--surface-inset)', padding: '10px 12px' }}>
              <div style={{ fontFamily: 'var(--font-mono)', fontSize: 9, letterSpacing: '0.12em', textTransform: 'uppercase', color: 'var(--text-muted)', marginBottom: 4 }}>{l}</div>
              <div style={{ fontSize: 12, fontWeight: 500, color: 'var(--text-primary)', fontFamily: 'var(--font-mono)' }}>{v}</div>
            </div>
          ))}
        </div>

        {/* Quote options */}
        <div style={{ marginBottom: 16 }}>
          <p style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--text-muted)', letterSpacing: '0.1em', marginBottom: 10, textTransform: 'uppercase' }}>Vendor options</p>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 1, borderRadius: 'var(--radius-sm)', overflow: 'hidden', border: '1px solid var(--border-subtle)' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '10px 14px', background: 'var(--accent-dim)', border: '1px solid var(--accent-border)', borderRadius: 'var(--radius-sm)' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--accent)' }}>✓</span>
                <div>
                  <p style={{ fontSize: 13, fontWeight: 600, color: 'var(--accent)' }}>{p.selectedOffer.vendor}</p>
                  <p style={{ fontSize: 11, color: 'var(--text-muted)' }}>{p.selectedOffer.process} · {p.selectedOffer.certifications}</p>
                </div>
              </div>
              <div style={{ textAlign: 'right' }}>
                <p style={{ fontSize: 18, fontWeight: 700, fontFamily: 'var(--font-mono)', color: 'var(--accent)' }}>${p.selectedOffer.price.toLocaleString()}</p>
                <p style={{ fontSize: 10, color: 'var(--text-muted)' }}>{p.selectedOffer.leadTime} bd</p>
              </div>
            </div>
            {p.otherOffers.map(offer => (
              <div key={offer.vendor} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '10px 14px', background: 'var(--surface-inset)' }}>
                <div>
                  <p style={{ fontSize: 13, fontWeight: 500, color: 'var(--text-primary)' }}>{offer.vendor}</p>
                  <p style={{ fontSize: 11, color: 'var(--text-muted)' }}>{offer.process}</p>
                </div>
                <div style={{ textAlign: 'right' }}>
                  <p style={{ fontSize: 16, fontWeight: 600, fontFamily: 'var(--font-mono)', color: 'var(--text-primary)' }}>${offer.price.toLocaleString()}</p>
                  <p style={{ fontSize: 10, color: 'var(--text-muted)' }}>{offer.leadTime} bd</p>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* File + activity */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          <div className="card-inset" style={{ minHeight: 120, display: 'grid', placeItems: 'center', color: 'var(--text-muted)', fontSize: 11, cursor: 'pointer' }}>
            {p.drawingFile} · PDF
          </div>
          <div className="card-inset" style={{ minHeight: 120, display: 'grid', placeItems: 'center', color: 'var(--text-muted)', fontSize: 11, cursor: 'pointer' }}>
            {p.cadFile} · STEP
          </div>
        </div>

        {/* Footer shortcuts */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 16, marginTop: 16, paddingTop: 12, borderTop: '1px solid var(--border-subtle)' }}>
          <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>
            {p.material} · {p.finish} · {p.quantity} pcs
          </span>
          <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
            {[['←', 'back'], ['→', 'next part'], ['R', 'request quote']].map(([k, l]) => (
              <span key={k} style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 10, color: 'var(--text-muted)' }}>
                <kbd style={{ fontFamily: 'var(--font-mono)', fontSize: 9, background: 'var(--surface-inset)', border: '1px solid var(--border-default)', borderRadius: 3, padding: '1px 4px' }}>{k}</kbd>
                {l}
              </span>
            ))}
          </div>
        </div>
      </div>
    </Shell>
  );
}
