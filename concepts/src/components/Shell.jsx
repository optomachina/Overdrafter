// Shared shell layout used by all 5 concepts
import React, { useState } from 'react';
import { mockProjects, mockParts, currentUser, navItems } from '../data/mockData.jsx';

export function Shell({ children, theme, activePage = 'home', conceptLetter }) {
  const [collapsed, setCollapsed] = useState(false);

  return (
    <div className={`app-shell theme-${theme}`}>
      <aside className={`sidebar${collapsed ? ' collapsed' : ''}`}>
        <div className="sidebar-header">
          {!collapsed && (
            <span className="landing-logo">OD</span>
          )}
          <button
            className="btn btn-ghost btn-icon btn-sm"
            onClick={() => setCollapsed(c => !c)}
            style={{ marginLeft: 'auto' }}
          >
            {collapsed ? '→' : '←'}
          </button>
        </div>

        {!collapsed && (
          <>
            <div className="sidebar-section">
              <p className="sidebar-section-label">Navigate</p>
              {navItems.map(item => (
                <div key={item.id} className={`sidebar-item${activePage === item.id ? ' active' : ''}`}>
                  <span className="icon" style={{ fontFamily: 'var(--font-mono)', fontSize: 11, fontWeight: 700 }}>{item.icon}</span>
                  <span>{item.label}</span>
                </div>
              ))}
            </div>

            <div className="sidebar-section">
              <p className="sidebar-section-label">Projects</p>
              {mockProjects.filter(p => p.status !== 'archived').map(project => (
                <div key={project.id} className="sidebar-item">
                  <span className="icon" style={{ opacity: 0.5 }}>◈</span>
                  <span className="truncate" style={{ fontSize: 12 }}>{project.name}</span>
                  <span className="sidebar-item-sub">{project.partCount}</span>
                </div>
              ))}
              <div className="sidebar-item" style={{ color: 'var(--text-muted)', fontSize: 12 }}>
                <span className="icon" style={{ opacity: 0.4 }}>···</span>
                <span>View all</span>
              </div>
            </div>

            <div style={{ flex: 1 }} />

            <div className="sidebar-footer">
              <div className="sidebar-item">
                <div className="avatar">{currentUser.initials}</div>
                <div style={{ minWidth: 0 }}>
                  <p style={{ fontSize: 12, fontWeight: 500, color: 'var(--text-primary)' }}>{currentUser.name}</p>
                  <p style={{ fontSize: 10, color: 'var(--text-muted)' }}>{currentUser.email}</p>
                </div>
              </div>
            </div>
          </>
        )}

        {collapsed && (
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8, padding: '12px 0', flex: 1 }}>
            {navItems.map(item => (
              <div key={item.id} className={`sidebar-item${activePage === item.id ? ' active' : ''}`} style={{ justifyContent: 'center', padding: '8px' }}>
                <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, fontWeight: 700 }}>{item.icon}</span>
              </div>
            ))}
          </div>
        )}
      </aside>

      <div className="main-area">
        <header className="topbar">
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <span className="section-label">{conceptLetter} /</span>
            <span style={{ fontSize: 13, fontWeight: 500, color: 'var(--text-primary)' }}>OverDrafter Workspace</span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <button className="btn btn-outline btn-sm">⌘K</button>
            <button className="btn btn-primary btn-sm">+ Upload</button>
          </div>
        </header>
        <main className="content-area">
          {children}
        </main>
      </div>
    </div>
  );
}
