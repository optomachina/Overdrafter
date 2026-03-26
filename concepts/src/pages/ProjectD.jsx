// THEME D: Chronicle — Project as editorial lede + structured record
import React from 'react';
import { Shell } from '../components/Shell.jsx';
import { mockParts, mockActivity } from '../data/mockData.jsx';

export default function ProjectChronicle() {
  return (
    <Shell theme="d" activePage="projects" conceptLetter="D">
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 280px', gap: 28 }}>
        {/* Main */}
        <div>
          {/* Lede */}
          <div style={{ marginBottom: 28 }}>
            <p className="section-label" style={{ marginBottom: 8 }}>// project lede</p>
            <h1 style={{ fontSize: 26, fontWeight: 700, letterSpacing: '-0.025em', color: 'var(--text-primary)', lineHeight: 1.2, marginBottom: 10 }}>
              FLT Drone Frame Assembly
            </h1>
            <p style={{ fontSize: 14, color: 'var(--text-secondary)', lineHeight: 1.7, maxWidth: 520 }}>
              A 12-part CNC machining intake for drone frame structural components. Material mix spans 6061-T6 and 7075-T651 aluminum, with Delrin and carbon fiberlaminate enclosures. Quote review is underway — 2 packages received, 1 stalled.
            </p>
            <div style={{ display: 'flex', gap: 8, marginTop: 14 }}>
              <button className="btn btn-primary btn-sm">Request remaining quotes</button>
              <button className="btn btn-outline btn-sm">View extraction log</button>
            </div>
          </div>

          {/* Stats row */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 10, marginBottom: 28 }}>
            {[['12', 'Total parts'], ['2', 'Quotes received'], ['1', 'Requesting'], ['1', 'Needs review']].map(([v, l]) => (
              <div key={l} className="stat-card" style={{ padding: '12px 14px' }}>
                <div style={{ fontSize: 22, fontWeight: 700, fontFamily: 'var(--font-mono)', color: 'var(--text-primary)' }}>{v}</div>
                <div style={{ fontSize: 10, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.08em', marginTop: 2 }}>{l}</div>
              </div>
            ))}
          </div>

          {/* Parts narrative */}
          <div style={{ marginBottom: 24 }}>
            <p className="section-label" style={{ marginBottom: 12 }}>Parts manifest</p>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Part identifier</th>
                    <th>Revision</th>
                    <th>Material</th>
                    <th>Quote status</th>
                    <th>Decision</th>
                  </tr>
                </thead>
                <tbody>
                  {mockParts.map(part => (
                    <tr key={part.id} style={{ cursor: 'pointer' }}>
                      <td>
                        <p style={{ fontSize: 13, fontWeight: 500, color: 'var(--text-primary)' }}>{part.name}</p>
                        <p style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 1 }}>{part.description}</p>
                      </td>
                      <td style={{ fontFamily: 'var(--font-mono)', fontSize: 11 }}>{part.rev}</td>
                      <td style={{ fontSize: 12 }}>{part.material.split(' ')[0]}</td>
                      <td>
                        <span className={`badge badge-${part.status === 'received' ? 'accent' : part.status === 'requesting' ? 'warning' : part.status === 'failed' ? 'danger' : 'neutral'}`}>
                          {part.status === 'received' ? 'Received' : part.status === 'requesting' ? 'Requesting' : part.status === 'failed' ? 'Failed' : 'Pending'}
                        </span>
                      </td>
                      <td>
                        {part.selected && (
                          <span style={{ fontSize: 12, color: '#fb923c', fontWeight: 500 }}>✓ Selected</span>
                        )}
                        {!part.selected && part.status === 'received' && (
                          <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>Pending</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>

        {/* Sidebar */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
          {/* Timeline */}
          <div className="card">
            <p className="section-label" style={{ marginBottom: 14 }}>Project history</p>
            <div>
              {mockActivity.map((act, i) => (
                <div key={act.id} style={{ display: 'flex', gap: 10, marginBottom: 14 }}>
                  <div style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--accent)', marginTop: 5, flexShrink: 0 }} />
                  <div>
                    <p style={{ fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.5 }}>
                      <span style={{ fontWeight: 500, color: 'var(--text-primary)' }}>{act.actor}</span>{' '}{act.type.replace('_', ' ')}{act.part ? ` · ${act.part}` : ''}
                    </p>
                    <p style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 1 }}>{act.detail}</p>
                    <p style={{ fontFamily: 'var(--font-mono)', fontSize: 9, color: 'var(--text-faint)', marginTop: 2 }}>{act.time}</p>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Materials */}
          <div className="card">
            <p className="section-label" style={{ marginBottom: 12 }}>Materials</p>
            {['6061-T6 Aluminum', '7075-T651 Aluminum', 'Delrin (Acetal)', 'CF laminate'].map(m => (
              <div key={m} style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                <div style={{ width: 6, height: 6, borderRadius: '50%', background: '#fb923c', flexShrink: 0 }} />
                <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>{m}</span>
              </div>
            ))}
          </div>

          {/* Team */}
          <div className="card">
            <p className="section-label" style={{ marginBottom: 12 }}>Team</p>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {['Blaine Wilson', 'Sam Chen'].map(name => (
                <div key={name} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <div className="avatar">{name.split(' ').map(n => n[0]).join('')}</div>
                  <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>{name}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </Shell>
  );
}
