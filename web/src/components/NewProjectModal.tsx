import { useState, useEffect, useCallback } from 'react';
import { StackTemplate, ProjectConfig, ScaffoldProgress, ScaffoldResult } from '../types';
import { connectionManager } from '../services/ConnectionManager';

type WizardStep = 'details' | 'template' | 'options' | 'creating' | 'done';

interface NewProjectModalProps {
  serverId: string;
  onClose: () => void;
  onComplete?: (projectPath: string) => void;
}

export function NewProjectModal({ serverId, onClose, onComplete }: NewProjectModalProps) {
  const [step, setStep] = useState<WizardStep>('details');
  const [templates, setTemplates] = useState<StackTemplate[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Form state
  const [projectName, setProjectName] = useState('');
  const [projectDescription, setProjectDescription] = useState('');
  const [selectedTemplate, setSelectedTemplate] = useState<string | null>(null);
  const [location, setLocation] = useState('~/projects');
  const [initGit, setInitGit] = useState(true);
  const [createGitHubRepo, setCreateGitHubRepo] = useState(false);
  const [privateRepo, setPrivateRepo] = useState(true);

  // Progress state
  const [progress, setProgress] = useState<ScaffoldProgress | null>(null);
  const [result, setResult] = useState<ScaffoldResult | null>(null);

  const loadTemplates = useCallback(async (description?: string) => {
    setLoading(true);
    setError(null);
    try {
      const conn = connectionManager.getConnection(serverId);
      if (!conn) { setError('Not connected'); setLoading(false); return; }
      const payload: { description?: string } = {};
      if (description?.trim()) payload.description = description;
      const response = await conn.sendRequest('get_scaffold_templates', payload);
      if (response.success && response.payload) {
        const data = response.payload as { templates: StackTemplate[] };
        setTemplates(data.templates);
        const top = data.templates[0];
        if (top?.score && top.score > 0.5) setSelectedTemplate(top.id);
      } else {
        setError(response.error || 'Failed to load templates');
      }
    } catch {
      setError('Failed to connect to server');
    } finally {
      setLoading(false);
    }
  }, [serverId]);

  useEffect(() => { loadTemplates(); }, [loadTemplates]);

  const handleCreate = useCallback(async () => {
    if (!projectName || !selectedTemplate) return;
    setStep('creating');
    setProgress({ step: 'Starting...', progress: 0, complete: false });
    try {
      const conn = connectionManager.getConnection(serverId);
      if (!conn) { setError('Not connected'); return; }
      const config: ProjectConfig = {
        name: projectName,
        description: projectDescription || `A ${templates.find(t => t.id === selectedTemplate)?.name} project`,
        location,
        stackId: selectedTemplate,
        options: { initGit, createGitHubRepo, privateRepo, includeDocker: false, includeCI: false, includeLinter: true },
      };
      const response = await conn.sendRequest('scaffold_create', config, 120000);
      if (response.success && response.payload) {
        const res = response.payload as ScaffoldResult;
        setResult(res);
        setStep('done');
      } else {
        setProgress({ step: 'Error', error: response.error || 'Creation failed', progress: 0, complete: true });
      }
    } catch {
      setProgress({ step: 'Error', error: 'Request failed', progress: 0, complete: true });
    }
  }, [serverId, projectName, selectedTemplate, projectDescription, location, templates, initGit, createGitHubRepo, privateRepo]);

  const canAdvance = step === 'details' ? projectName.trim().length > 0 : step === 'template' ? !!selectedTemplate : true;

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 520 }}>
        <div className="form-header">
          <button className="icon-btn small" onClick={step === 'details' ? onClose : () => setStep(step === 'template' ? 'details' : step === 'options' ? 'template' : 'details')}>
            {step === 'details' ? '\u00d7' : '\u2190'}
          </button>
          <h2>New Project</h2>
          <div className="header-spacer" />
        </div>

        <div style={{ padding: '20px 24px' }}>
          {step === 'details' && (
            <>
              <div className="form-group">
                <label>Project Name</label>
                <input type="text" value={projectName} onChange={(e) => setProjectName(e.target.value)} placeholder="my-project" />
              </div>
              <div className="form-group">
                <label>Description (optional)</label>
                <input type="text" value={projectDescription} onChange={(e) => setProjectDescription(e.target.value)} placeholder="A brief description..." />
              </div>
              <div className="form-group">
                <label>Location</label>
                <input type="text" value={location} onChange={(e) => setLocation(e.target.value)} placeholder="~/projects" />
              </div>
              <button className="btn-primary" onClick={() => { loadTemplates(projectDescription); setStep('template'); }} disabled={!canAdvance}>
                Choose Template
              </button>
            </>
          )}

          {step === 'template' && (
            <>
              {loading ? (
                <div style={{ textAlign: 'center', padding: 32 }}><div className="spinner" style={{ margin: '0 auto' }} /></div>
              ) : error ? (
                <div style={{ textAlign: 'center', padding: 32, color: 'var(--accent-red)' }}>{error}</div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8, maxHeight: 400, overflowY: 'auto' }}>
                  {templates.map((t) => (
                    <button
                      key={t.id}
                      onClick={() => setSelectedTemplate(t.id)}
                      style={{
                        display: 'flex', alignItems: 'center', gap: 12,
                        padding: '12px 16px', borderRadius: 8, border: `1px solid ${selectedTemplate === t.id ? 'var(--accent-blue)' : 'var(--border-color)'}`,
                        background: selectedTemplate === t.id ? 'rgba(59, 130, 246, 0.1)' : 'var(--bg-secondary)',
                        cursor: 'pointer', textAlign: 'left', color: 'var(--text-primary)', width: '100%',
                      }}
                    >
                      <span style={{ fontSize: 24 }}>{t.icon}</span>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontWeight: 600, fontSize: 14 }}>{t.name}</div>
                        <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 2 }}>{t.description}</div>
                        {t.score !== undefined && t.score > 0 && (
                          <div style={{ fontSize: 11, color: 'var(--accent-green)', marginTop: 2 }}>
                            {Math.round(t.score * 100)}% match
                          </div>
                        )}
                      </div>
                    </button>
                  ))}
                </div>
              )}
              <button className="btn-primary" onClick={() => setStep('options')} disabled={!canAdvance} style={{ marginTop: 16 }}>
                Configure Options
              </button>
            </>
          )}

          {step === 'options' && (
            <>
              <div className="form-group checkbox">
                <input type="checkbox" id="initGit" checked={initGit} onChange={(e) => setInitGit(e.target.checked)} />
                <label htmlFor="initGit">Initialize Git repository</label>
              </div>
              <div className="form-group checkbox">
                <input type="checkbox" id="createGithub" checked={createGitHubRepo} onChange={(e) => setCreateGitHubRepo(e.target.checked)} />
                <label htmlFor="createGithub">Create GitHub repository</label>
              </div>
              {createGitHubRepo && (
                <div className="form-group checkbox" style={{ paddingLeft: 30 }}>
                  <input type="checkbox" id="privateRepo" checked={privateRepo} onChange={(e) => setPrivateRepo(e.target.checked)} />
                  <label htmlFor="privateRepo">Private repository</label>
                </div>
              )}
              <button className="btn-primary" onClick={handleCreate}>
                Create Project
              </button>
            </>
          )}

          {step === 'creating' && progress && (
            <div style={{ textAlign: 'center', padding: 24 }}>
              {progress.error ? (
                <>
                  <p style={{ color: 'var(--accent-red)', marginBottom: 12 }}>{progress.error}</p>
                  <button className="btn-primary" onClick={onClose} style={{ maxWidth: 140 }}>Close</button>
                </>
              ) : (
                <>
                  <div className="spinner" style={{ margin: '0 auto 16px' }} />
                  <p style={{ fontWeight: 500 }}>{progress.step}</p>
                  {progress.detail && <p style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 4 }}>{progress.detail}</p>}
                  <div className="usage-bar-track" style={{ marginTop: 16 }}>
                    <div className="usage-bar-fill normal" style={{ width: `${progress.progress}%` }} />
                  </div>
                </>
              )}
            </div>
          )}

          {step === 'done' && result && (
            <div style={{ textAlign: 'center', padding: 24 }}>
              <p style={{ fontSize: 24, marginBottom: 8 }}>{result.success ? '\u2713' : '\u2717'}</p>
              <p style={{ fontWeight: 600, marginBottom: 4 }}>{result.success ? 'Project Created' : 'Creation Failed'}</p>
              {result.projectPath && (
                <p style={{ fontSize: 13, color: 'var(--text-secondary)', fontFamily: 'var(--font-mono)', marginBottom: 16 }}>
                  {result.projectPath}
                </p>
              )}
              {result.error && <p style={{ color: 'var(--accent-red)', marginBottom: 12 }}>{result.error}</p>}
              <button className="btn-primary" onClick={() => { if (result.success && result.projectPath && onComplete) onComplete(result.projectPath); onClose(); }} style={{ maxWidth: 200 }}>
                {result.success ? 'Open Project' : 'Close'}
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
