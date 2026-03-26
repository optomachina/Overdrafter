// THEME B: Command — Minimal table, keyboard-driven, focused
import React, { useState } from 'react';
import { Shell } from '../components/Shell.jsx';
import { mockParts } from '../data/mockData.jsx';

export default function ProjectCommand() {
  const [selected, setSelected] = useState(mockParts[0].id);
  const [filter, setFilter] = useState('all');

  const filters = ['all', 'ready', 'pending', 'failed'];
  const filtered = mockParts.filter(p =>
    filter === 'all' ? true :
    filter === 'ready' ? p.status === 'received' :
    filter === 'pending' ? p.status === 'requesting' || p.status === 'not_requested' :
    p.status === 'failed'
  );

  return (
    <Shell theme="b" activePage="projects" conceptLetter="B">
      <div style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
        {/* Minimal header */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20, paddingBottom: 16, borderBottom: '1px solid var(--border-subtle)' }}>
          <div>
            <p style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--text-muted)', letterSpacing: '0.08em', marginBottom: 4 }}>// PROJECT</p>
            <h1 style={{ fontSize: 20, fontWeight: 600, letterSpacing: '-0.02em', color: 'var(--text-primary)' }}>FLT Drone Frame Assembly</h1>
          </div>
          <div style={{ display: 'flex', gap: 6 }}>
            <kbd style={{ fontFamily: 'var(--font-mono)', fontSize: 10, background: 'var(--surface-inset)', border: '1px solid var(--border-default)', borderRadius: 4, padding: '2px 6px' }}>R</kbd>
            <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>request quotes</span>
            <kbd style={{ fontFamily: 'var(--font-mono)', fontSize: 10, background: 'var(--surface-inset)', border: '1px solid var(--border-default)', borderRadius: 4, padding: '2px 6px' }}>A</kbd>
            <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>add part</span>
          </div>
        </div>

        {/* Filter pills */}
        <div style={{ display: 'flex', gap: 6, marginBottom: 16 }}>
          {filters.map(f => (
            <button key={f} className={`pill${filter === f ? ' active' : ''}`} onClick={() => setFilter(f)}>
              {f}
            </button>
          ))}
        </div>

        {/* Dense table */}
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th style={{ width: '40%' }}>Name</th>
                <th>Status</th>
                <th>Quote</th>
                <th>Vendor</th>
                <th>Lead</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map(part => (
                <tr key={part.id} className={selected === part.id ? 'selected' : ''} onClick={() => setSelected(part.id)}>
                  <td>
                    <div>
                      <p style={{ fontSize: 13, fontWeight: 500, color: 'var(--text-primary)' }}>{part.name}</p>
                      <p style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 1 }}>{part.material}</p>
                    </div>
                  </td>
                  <td>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <span className={`status-dot status-${part.status === 'received' ? 'received' : part.status === 'requesting' ? 'requesting' : part.status === 'failed' ? 'failed' : 'idle'}`} />
                      <span style={{ fontSize: 12, color: 'var(--text-secondary)', textTransform: 'capitalize' }}>{part.status.replace('_', ' ')}</span>
                    </div>
                  </td>
                  <td style={{ fontFamily: 'var(--font-mono)', fontSize: 13, fontWeight: 600, color: part.quotePrice ? 'var(--accent)' : 'var(--text-faint)' }}>
                    {part.quotePrice ?? '—'}
                  </td>
                  <td style={{ fontSize: 12, color: 'var(--text-muted)' }}>{part.vendor ?? '—'}</td>
                  <td style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--text-muted)' }}>{part.leadTime ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* Command bar footer */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 16, marginTop: 16, paddingTop: 12, borderTop: '1px solid var(--border-subtle)' }}>
          <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
            {filtered.length} parts ·{' '}
            <span style={{ color: 'var(--accent)' }}>{filtered.filter(p => p.status === 'received').length} ready</span>
          </span>
          <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
            {[['⌘K', 'search'], ['↵', 'open'], ['esc', 'deselect']].map(([k, l]) => (
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
