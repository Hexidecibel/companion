import { useState, useMemo } from 'react';
import { Skill } from '../types';
import { useSkills } from '../hooks/useSkills';

interface SkillBrowserProps {
  serverId: string;
  onClose: () => void;
}

const CATEGORIES = ['all', 'workflow', 'dev', 'git', 'ops', 'search'] as const;
type Category = typeof CATEGORIES[number];

const CATEGORY_LABELS: Record<Category, string> = {
  all: 'All',
  workflow: 'Workflow',
  dev: 'Development',
  git: 'Git',
  ops: 'Operations',
  search: 'Search',
};

export function SkillBrowser({ serverId, onClose }: SkillBrowserProps) {
  const { skills, loading, error, installSkill, uninstallSkill, refresh } = useSkills(serverId);
  const [category, setCategory] = useState<Category>('all');
  const [search, setSearch] = useState('');
  const [installing, setInstalling] = useState<string | null>(null);

  const filtered = useMemo(() => {
    let list = skills;
    if (category !== 'all') {
      list = list.filter((s) => s.category === category);
    }
    if (search) {
      const lower = search.toLowerCase();
      list = list.filter(
        (s) =>
          s.name.toLowerCase().includes(lower) ||
          s.id.toLowerCase().includes(lower) ||
          s.description.toLowerCase().includes(lower)
      );
    }
    return list;
  }, [skills, category, search]);

  const installedCount = skills.filter((s) => s.installed).length;
  const catalogCount = skills.filter((s) => !s.installed).length;

  const handleInstall = async (skill: Skill) => {
    setInstalling(skill.id);
    await installSkill(skill.id, 'project');
    setInstalling(null);
  };

  const handleUninstall = async (skill: Skill) => {
    setInstalling(skill.id);
    const source = skill.source === 'global' ? 'global' : 'project';
    await uninstallSkill(skill.id, source);
    setInstalling(null);
  };

  return (
    <div className="modal-overlay" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="skill-browser">
        <header className="skill-browser-header">
          <button className="icon-btn" onClick={onClose}>&larr;</button>
          <h2>Skills</h2>
          <button className="icon-btn" onClick={refresh} title="Refresh">&#x21bb;</button>
        </header>

        <div className="skill-browser-stats">
          <span className="skill-stat">{installedCount} installed</span>
          <span className="skill-stat">{catalogCount} available</span>
        </div>

        <div className="skill-browser-search">
          <input
            type="text"
            placeholder="Search skills..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="skill-search-input"
          />
        </div>

        <div className="skill-browser-categories">
          {CATEGORIES.map((cat) => (
            <button
              key={cat}
              className={`skill-category-btn ${category === cat ? 'active' : ''}`}
              onClick={() => setCategory(cat)}
            >
              {CATEGORY_LABELS[cat]}
            </button>
          ))}
        </div>

        <div className="skill-browser-body">
          {loading && <div className="skill-browser-loading">Loading skills...</div>}
          {error && <div className="skill-browser-error">{error}</div>}
          {!loading && !error && filtered.length === 0 && (
            <div className="skill-browser-empty">No skills found</div>
          )}
          {filtered.map((skill) => (
            <div key={skill.id} className={`skill-card ${skill.installed ? 'installed' : ''}`}>
              <div className="skill-card-header">
                <span className="skill-card-name">/{skill.id}</span>
                <span className="skill-card-category">{skill.category}</span>
              </div>
              <div className="skill-card-title">{skill.name}</div>
              <div className="skill-card-desc">{skill.description}</div>
              {skill.prerequisites && skill.prerequisites.length > 0 && (
                <div className="skill-card-prereqs">
                  Requires: {skill.prerequisites.join(', ')}
                </div>
              )}
              <div className="skill-card-actions">
                {skill.installed ? (
                  <>
                    <span className="skill-card-badge">
                      Installed ({skill.source})
                    </span>
                    <button
                      className="skill-card-btn skill-card-btn-remove"
                      onClick={() => handleUninstall(skill)}
                      disabled={installing === skill.id}
                    >
                      {installing === skill.id ? '...' : 'Remove'}
                    </button>
                  </>
                ) : (
                  <button
                    className="skill-card-btn skill-card-btn-install"
                    onClick={() => handleInstall(skill)}
                    disabled={installing === skill.id}
                  >
                    {installing === skill.id ? 'Installing...' : 'Install'}
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
