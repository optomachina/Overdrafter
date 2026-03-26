import React, { useState } from 'react';
import { HashRouter, Routes, Route } from 'react-router-dom';
import HomeA from './pages/HomeA.jsx';
import HomeB from './pages/HomeB.jsx';
import HomeC from './pages/HomeC.jsx';
import HomeD from './pages/HomeD.jsx';
import HomeE from './pages/HomeE.jsx';
import ProjectA from './pages/ProjectA.jsx';
import ProjectB from './pages/ProjectB.jsx';
import ProjectC from './pages/ProjectC.jsx';
import ProjectD from './pages/ProjectD.jsx';
import ProjectE from './pages/ProjectE.jsx';
import PartA from './pages/PartA.jsx';
import PartB from './pages/PartB.jsx';
import PartC from './pages/PartC.jsx';
import PartD from './pages/PartD.jsx';
import PartE from './pages/PartE.jsx';

const CONCEPTS = [
  {
    id: 'a',
    letter: 'A',
    name: 'Precision',
    tagline: 'Refined clarity',
    description: 'Tighter spacing, sharper hierarchy, quieter chrome. The natural evolution of the existing design language.',
    accent: '#34d399',
    accentDim: 'rgba(52,211,153,0.1)',
    accentBorder: 'rgba(52,211,153,0.25)',
    pages: ['Home', 'Project', 'Part'],
  },
  {
    id: 'b',
    letter: 'B',
    name: 'Command',
    tagline: 'Keyboard-first',
    description: 'Power-user mode. Persistent command palette, keyboard shortcuts, minimal visible UI chrome. Built for speed.',
    accent: '#a78bfa',
    accentDim: 'rgba(167,139,250,0.1)',
    accentBorder: 'rgba(167,139,250,0.25)',
    pages: ['Home', 'Project', 'Part'],
  },
  {
    id: 'c',
    letter: 'C',
    name: 'Atlas',
    tagline: 'Spatial, immersive',
    description: 'Map-like part navigation, spatial node graph, cyan accent. Immersive file viewing with a geographic workspace metaphor.',
    accent: '#38bdf8',
    accentDim: 'rgba(56,189,248,0.1)',
    accentBorder: 'rgba(56,189,248,0.25)',
    pages: ['Home', 'Project', 'Part'],
  },
  {
    id: 'd',
    letter: 'D',
    name: 'Chronicle',
    tagline: 'Editorial, narrative',
    description: 'Activity-feed-first, timeline-centric, version history prominent. The project as a living document with editorial voice.',
    accent: '#fb923c',
    accentDim: 'rgba(251,146,60,0.1)',
    accentBorder: 'rgba(251,146,60,0.25)',
    pages: ['Home', 'Project', 'Part'],
  },
  {
    id: 'e',
    letter: 'E',
    name: 'Signal',
    tagline: 'Status-forward',
    description: 'Alert-centric, prominent notification states, quote health dashboard. Status is the primary navigation layer.',
    accent: '#f472b6',
    accentDim: 'rgba(244,114,182,0.1)',
    accentBorder: 'rgba(244,114,182,0.25)',
    pages: ['Home', 'Project', 'Part'],
  },
];

function Landing() {
  const [selectedConcept, setSelectedConcept] = useState(null);

  if (selectedConcept) {
    return (
      <div style={{ minHeight: '100vh', background: '#0a0a0a' }}>
        <header style={{ padding: '16px 24px', borderBottom: '1px solid rgba(255,255,255,0.07)', display: 'flex', alignItems: 'center', gap: 16 }}>
          <button
            className="btn btn-ghost btn-sm"
            onClick={() => setSelectedConcept(null)}
            style={{ color: 'rgba(255,255,255,0.5)' }}
          >
            ← Back
          </button>
          <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12, fontWeight: 700, color: selectedConcept.accent }}>{selectedConcept.letter} /</span>
          <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)' }}>{selectedConcept.name}</span>
          <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>— {selectedConcept.tagline}</span>
        </header>
        <div style={{ display: 'flex', height: 'calc(100vh - 57px)' }}>
          {/* Page nav sidebar */}
          <div style={{ width: 180, borderRight: '1px solid rgba(255,255,255,0.07)', padding: '20px 16px', flexShrink: 0 }}>
            <p style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'rgba(255,255,255,0.3)', letterSpacing: '0.1em', textTransform: 'uppercase', marginBottom: 12 }}>Pages</p>
            {selectedConcept.pages.map((page, i) => {
              const basePath = `#/${page.toLowerCase()}-${selectedConcept.id}`;
              return (
                <div key={page} style={{ marginBottom: 4 }}>
                  <a href={basePath} style={{ textDecoration: 'none' }}>
                    <div style={{
                      padding: '8px 12px',
                      borderRadius: 8,
                      cursor: 'pointer',
                      background: 'transparent',
                      border: '1px solid transparent',
                      transition: 'all 0.15s',
                    }}
                      onMouseEnter={e => {
                        e.currentTarget.style.background = 'rgba(255,255,255,0.04)';
                        e.currentTarget.style.borderColor = selectedConcept.accentBorder;
                      }}
                      onMouseLeave={e => {
                        e.currentTarget.style.background = 'transparent';
                        e.currentTarget.style.borderColor = 'transparent';
                      }}
                    >
                      <p style={{ fontSize: 13, fontWeight: 500, color: 'var(--text-primary)' }}>{page}</p>
                      <p style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 2 }}>{page === 'Home' ? 'No project selected' : page === 'Project' ? 'Project + sidebar + inspector' : 'Part detail + quote'}</p>
                    </div>
                  </a>
                </div>
              );
            })}
          </div>
          {/* Preview */}
          <iframe
            src={`#/${selectedConcept.pages[0].toLowerCase()}-${selectedConcept.id}`}
            style={{ flex: 1, border: 'none', background: '#0a0a0a' }}
            title="Preview"
          />
        </div>
      </div>
    );
  }

  return (
    <div className="landing">
      <div className="landing-header">
        <div className="landing-logo">OD</div>
        <span style={{ fontSize: 12, color: 'rgba(255,255,255,0.4)' }}>OverDrafter · Concept Pages</span>
        <div style={{ display: 'flex', gap: 8 }}>
          <a href="https://github.com/optomachina/Overdrafter" target="_blank" rel="noreferrer" className="btn btn-outline btn-sm">View repo</a>
        </div>
      </div>

      <div className="landing-hero">
        <p style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'rgba(255,255,255,0.35)', letterSpacing: '0.08em', marginBottom: 14 }}>
          // 5 design directions · 15 pages
        </p>
        <h1>Concept pages for<br /><em>OverDrafter</em></h1>
        <p>
          Three authenticated states — Home (no selection), Project (project + sidebar), Part (part detail) — explored through five distinct design languages. Click any card to explore all three pages.
        </p>
        <div className="pill-nav" style={{ justifyContent: 'center', marginTop: 8 }}>
          {CONCEPTS.map(c => (
            <a key={c.id} href={`#/${c.pages[0].toLowerCase()}-${c.id}`} style={{ textDecoration: 'none' }}>
              <button className="pill">
                <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, fontWeight: 700, color: c.accent }}>{c.letter}</span>
                <span>{c.name}</span>
              </button>
            </a>
          ))}
        </div>
      </div>

      <div className="landing-grid">
        {CONCEPTS.map(c => (
          <a key={c.id} href={`#/${c.pages[0].toLowerCase()}-${c.id}`} style={{ textDecoration: 'none' }}>
            <div
              className="concept-card"
              style={{ '--accent': c.accent, '--accent-dim': c.accentDim, '--accent-border': c.accentBorder }}
              onMouseEnter={e => {
                e.currentTarget.style.borderColor = c.accentBorder;
                e.currentTarget.style.transform = 'translateY(-3px)';
              }}
              onMouseLeave={e => {
                e.currentTarget.style.borderColor = 'rgba(255,255,255,0.07)';
                e.currentTarget.style.transform = 'translateY(0)';
              }}
            >
              <div className="concept-preview">
                <div style={{ width: '85%', height: 160, borderRadius: 12, background: 'var(--surface-raised)', border: '1px solid var(--border-default)', position: 'relative', overflow: 'hidden' }}>
                  {/* Mock layout preview */}
                  <div style={{ position: 'absolute', top: 0, left: 0, right: 0, height: 36, background: 'var(--surface-shell)', borderBottom: '1px solid var(--border-subtle)', display: 'flex', alignItems: 'center', padding: '0 12px', gap: 8 }}>
                    <div style={{ width: 20, height: 20, borderRadius: 5, background: c.accentDim, border: `1px solid ${c.accentBorder}`, display: 'grid', placeItems: 'center', fontSize: 9, fontFamily: 'var(--font-mono)', fontWeight: 700, color: c.accent }}>OD</div>
                    <div style={{ flex: 1, height: 6, borderRadius: 3, background: 'var(--surface-inset)', maxWidth: 80 }} />
                  </div>
                  <div style={{ position: 'absolute', top: 44, left: 10, right: 10, display: 'flex', flexDirection: 'column', gap: 6 }}>
                    <div style={{ height: 8, borderRadius: 4, background: 'var(--surface-inset)', width: '60%' }} />
                    <div style={{ height: 8, borderRadius: 4, background: 'var(--surface-inset)', width: '40%' }} />
                    <div style={{ height: 32, borderRadius: 8, background: 'var(--surface-inset)', marginTop: 4 }} />
                    <div style={{ display: 'flex', gap: 6, marginTop: 2 }}>
                      <div style={{ flex: 1, height: 48, borderRadius: 8, background: 'var(--surface-inset)' }} />
                      <div style={{ flex: 1, height: 48, borderRadius: 8, background: 'var(--surface-inset)' }} />
                    </div>
                  </div>
                  {/* Color accent strip */}
                  <div style={{ position: 'absolute', bottom: 0, left: 0, right: 0, height: 3, background: c.accent, opacity: 0.6 }} />
                </div>
              </div>
              <div className="concept-info">
                <div className="concept-letter" style={{ background: c.accentDim, border: `1px solid ${c.accentBorder}`, color: c.accent }}>
                  {c.letter}
                </div>
                <div className="concept-name">{c.name}</div>
                <div className="concept-desc">{c.description}</div>
                <div style={{ display: 'flex', gap: 6, marginTop: 10, flexWrap: 'wrap' }}>
                  {c.pages.map(pg => (
                    <span key={pg} style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--text-faint)', border: '1px solid rgba(255,255,255,0.06)', borderRadius: 9999, padding: '2px 7px' }}>
                      {pg}
                    </span>
                  ))}
                </div>
                <span className="concept-tag">{c.tagline}</span>
              </div>
            </div>
          </a>
        ))}
      </div>

      <div style={{ padding: '0 40px 60px', maxWidth: 600, width: '100%', margin: '0 auto' }}>
        <p style={{ fontSize: 12, color: 'rgba(255,255,255,0.25)', lineHeight: 1.7, textAlign: 'center' }}>
          All pages are standalone HTML/CSS/JS mockups with realistic data. They can be run as a static site via Vite, or individual page files can be opened directly in a browser.
        </p>
      </div>
    </div>
  );
}

export default function App() {
  return (
    <HashRouter>
      <Routes>
        <Route path="/" element={<Landing />} />
        <Route path="/home-a" element={<HomeA />} />
        <Route path="/home-b" element={<HomeB />} />
        <Route path="/home-c" element={<HomeC />} />
        <Route path="/home-d" element={<HomeD />} />
        <Route path="/home-e" element={<HomeE />} />
        <Route path="/project-a" element={<ProjectA />} />
        <Route path="/project-b" element={<ProjectB />} />
        <Route path="/project-c" element={<ProjectC />} />
        <Route path="/project-d" element={<ProjectD />} />
        <Route path="/project-e" element={<ProjectE />} />
        <Route path="/part-a" element={<PartA />} />
        <Route path="/part-b" element={<PartB />} />
        <Route path="/part-c" element={<PartC />} />
        <Route path="/part-d" element={<PartD />} />
        <Route path="/part-e" element={<PartE />} />
      </Routes>
    </HashRouter>
  );
}
