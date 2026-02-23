import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { StackTemplate, ProjectConfig, ScaffoldProgress, ScaffoldResult } from '../types';
import { connectionManager } from '../services/ConnectionManager';
import { FileViewerModal } from './FileViewerModal';

type WizardStep = 'details' | 'template' | 'options' | 'preview' | 'creating' | 'done';

const STEP_ORDER: WizardStep[] = ['details', 'template', 'options', 'preview', 'creating', 'done'];

interface NewProjectModalProps {
  serverId: string;
  onClose: () => void;
  onComplete?: (projectPath: string, sessionName?: string) => void;
}

// --- File tree helpers ---

interface TreeNode {
  name: string;
  children?: TreeNode[];
}

function buildFileTree(files: string[]): TreeNode[] {
  const root: TreeNode[] = [];

  for (const filePath of files) {
    const parts = filePath.split('/');
    let current = root;

    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      const isDir = i < parts.length - 1;

      let existing = current.find(
        (n) => n.name === (isDir ? part + '/' : part)
      );

      if (!existing) {
        existing = { name: isDir ? part + '/' : part };
        if (isDir) existing.children = [];
        current.push(existing);
      }

      if (isDir && existing.children) {
        current = existing.children;
      }
    }
  }

  return root;
}

function renderTree(nodes: TreeNode[], prefix: string = '', basePath?: string, onFileClick?: (filePath: string) => void): JSX.Element[] {
  const elements: JSX.Element[] = [];
  const sorted = [...nodes].sort((a, b) => {
    // Dirs first
    const aDir = a.children ? 0 : 1;
    const bDir = b.children ? 0 : 1;
    if (aDir !== bDir) return aDir - bDir;
    return a.name.localeCompare(b.name);
  });

  for (let i = 0; i < sorted.length; i++) {
    const node = sorted[i];
    const isLast = i === sorted.length - 1;
    const connector = isLast ? '\u2514\u2500 ' : '\u251C\u2500 ';
    const childPrefix = prefix + (isLast ? '   ' : '\u2502  ');

    const isFile = !node.children;
    const fullPath = basePath ? `${basePath}/${node.name}` : node.name;
    elements.push(
      <div className="wizard-file-tree-item" key={prefix + node.name}>
        <span className="wizard-file-indent">{prefix}{connector}</span>
        {isFile && onFileClick ? (
          <span
            className="wizard-file-name wizard-file-clickable"
            onClick={() => onFileClick(fullPath)}
          >{node.name}</span>
        ) : (
          <span className={`wizard-file-name${node.children ? ' dir' : ''}`}>{node.name}</span>
        )}
      </div>
    );

    if (node.children) {
      const dirName = node.name.endsWith('/') ? node.name.slice(0, -1) : node.name;
      const childBasePath = basePath ? `${basePath}/${dirName}` : dirName;
      elements.push(...renderTree(node.children, childPrefix, childBasePath, onFileClick));
    }
  }

  return elements;
}

// --- Component ---

export function NewProjectModal({ serverId, onClose, onComplete }: NewProjectModalProps) {
  const [step, setStep] = useState<WizardStep>('details');
  const [direction, setDirection] = useState<'forward' | 'back'>('forward');
  const [templates, setTemplates] = useState<StackTemplate[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Form state
  const [projectName, setProjectName] = useState('');
  const [projectDescription, setProjectDescription] = useState('');
  const [selectedTemplate, setSelectedTemplate] = useState<string | null>(null);
  const [location, setLocation] = useState('~/projects');
  const [initGit, setInitGit] = useState(true);
  const [createGitHubRepo, setCreateGitHubRepo] = useState(false);
  const [privateRepo, setPrivateRepo] = useState(true);
  const [includeDocker, setIncludeDocker] = useState(false);
  const [includeCI, setIncludeCI] = useState(false);
  const [includeLinter, setIncludeLinter] = useState(true);
  const [viewingFile, setViewingFile] = useState<string | null>(null);

  // Preview state
  const [previewFiles, setPreviewFiles] = useState<string[]>([]);
  const [previewPath, setPreviewPath] = useState('');
  const [previewLoading, setPreviewLoading] = useState(false);

  // Progress state
  const [progress, setProgress] = useState<ScaffoldProgress | null>(null);
  const [result, setResult] = useState<ScaffoldResult | null>(null);

  // Debounce timer for live template re-ranking
  const descDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const conn = useMemo(() => connectionManager.getConnection(serverId), [serverId]);

  const stepIndex = STEP_ORDER.indexOf(step);

  // Navigate between steps
  const goTo = useCallback((target: WizardStep) => {
    const targetIdx = STEP_ORDER.indexOf(target);
    const currentIdx = STEP_ORDER.indexOf(step);
    setDirection(targetIdx > currentIdx ? 'forward' : 'back');
    setStep(target);
  }, [step]);

  // Load templates (with optional description for scoring)
  const loadTemplates = useCallback(async (description?: string) => {
    if (!conn) { setError('Not connected'); return; }
    setLoading(true);
    setError(null);
    try {
      const payload: { description?: string } = {};
      if (description?.trim()) payload.description = description;
      const response = await conn.sendRequest('get_scaffold_templates', payload);
      if (response.success && response.payload) {
        const data = response.payload as { templates: StackTemplate[] };
        setTemplates(data.templates);
        // Auto-select top match if score > 0.5
        const top = data.templates[0];
        if (top?.score && top.score > 0.5 && !selectedTemplate) {
          setSelectedTemplate(top.id);
        }
      } else {
        setError(response.error || 'Failed to load templates');
      }
    } catch {
      setError('Failed to connect to server');
    } finally {
      setLoading(false);
    }
  }, [conn, selectedTemplate]);

  // Debounced re-ranking as description changes
  useEffect(() => {
    if (step !== 'details') return;
    if (descDebounceRef.current) clearTimeout(descDebounceRef.current);
    if (!projectDescription.trim()) return;
    descDebounceRef.current = setTimeout(() => {
      loadTemplates(projectDescription);
    }, 400);
    return () => {
      if (descDebounceRef.current) clearTimeout(descDebounceRef.current);
    };
  }, [projectDescription, step, loadTemplates]);

  // Recommended template hint based on live scoring
  const recommendedTemplate = useMemo(() => {
    if (templates.length === 0) return null;
    const top = templates[0];
    if (top.score && top.score > 0.3) return top;
    return null;
  }, [templates]);

  // Load preview files
  const loadPreview = useCallback(async () => {
    if (!conn || !projectName || !selectedTemplate) return;
    setPreviewLoading(true);
    try {
      const config: ProjectConfig = {
        name: projectName,
        description: projectDescription,
        location,
        stackId: selectedTemplate,
        options: { initGit, createGitHubRepo, privateRepo, includeDocker, includeCI, includeLinter },
      };
      const response = await conn.sendRequest('scaffold_preview', config);
      if (response.success && response.payload) {
        const data = response.payload as { files: string[]; projectPath: string };
        setPreviewFiles(data.files);
        setPreviewPath(data.projectPath);
      }
    } catch {
      // Non-fatal, preview is optional
    } finally {
      setPreviewLoading(false);
    }
  }, [conn, projectName, selectedTemplate, projectDescription, location, initGit, createGitHubRepo, privateRepo, includeDocker, includeCI, includeLinter]);

  // Create project with progress streaming
  const handleCreate = useCallback(async () => {
    if (!conn || !projectName || !selectedTemplate) return;
    goTo('creating');
    setProgress({ step: 'Starting...', progress: 0, complete: false });

    // Subscribe to progress broadcasts
    const unsub = conn.onMessage((msg) => {
      if (msg.type === 'scaffold_progress' && msg.payload) {
        setProgress(msg.payload as ScaffoldProgress);
      }
    });

    try {
      const config: ProjectConfig = {
        name: projectName,
        description: projectDescription || `A ${templates.find(t => t.id === selectedTemplate)?.name || 'new'} project`,
        location,
        stackId: selectedTemplate,
        options: { initGit, createGitHubRepo, privateRepo, includeDocker, includeCI, includeLinter },
      };
      const response = await conn.sendRequest('scaffold_create', config, 120000);
      unsub();
      if (response.success && response.payload) {
        const res = response.payload as ScaffoldResult;
        setResult(res);
        goTo('done');
      } else {
        setProgress({ step: 'Error', error: response.error || 'Creation failed', progress: 0, complete: true });
      }
    } catch {
      unsub();
      setProgress({ step: 'Error', error: 'Request failed', progress: 0, complete: true });
    }
  }, [conn, serverId, projectName, selectedTemplate, projectDescription, location, templates, initGit, createGitHubRepo, privateRepo, includeDocker, includeCI, includeLinter, goTo]);

  // Open session in the newly created project
  const handleOpenSession = useCallback(async () => {
    if (!conn || !result?.projectPath) return;
    try {
      const templateName = templates.find(t => t.id === selectedTemplate)?.name;
      const response = await conn.sendRequest('scaffold_open_session', {
        workingDir: result.projectPath,
        projectName,
        projectDescription: projectDescription || undefined,
        templateName: templateName || undefined,
      });
      const sessionName = (response.payload as { sessionName?: string })?.sessionName;
      onComplete?.(result.projectPath, sessionName);
    } catch {
      // Fall through to close
    }
    onClose();
  }, [conn, result, onComplete, onClose, templates, selectedTemplate, projectName, projectDescription]);

  // Step navigation helpers
  const handleNextFromDetails = useCallback(() => {
    loadTemplates(projectDescription);
    goTo('template');
  }, [loadTemplates, projectDescription, goTo]);

  const handleNextFromTemplate = useCallback(() => {
    goTo('options');
  }, [goTo]);

  const handleNextFromOptions = useCallback(() => {
    loadPreview();
    goTo('preview');
  }, [loadPreview, goTo]);

  const canAdvance = step === 'details' ? projectName.trim().length > 0
    : step === 'template' ? !!selectedTemplate
    : true;

  const isBlank = selectedTemplate === 'blank';

  // File tree for preview and done screens
  const previewTree = useMemo(() => buildFileTree(previewFiles), [previewFiles]);
  const doneTree = useMemo(() => result?.filesCreated ? buildFileTree(result.filesCreated) : [], [result]);

  const slideClass = direction === 'forward' ? 'wizard-slide' : 'wizard-slide-back';

  return (
    <div className="modal-overlay wizard-modal" onClick={onClose}>
      <div className="modal-content" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 560 }}>
        {/* Header */}
        <div className="modal-header">
          <h3>New Project</h3>
          <button className="modal-close" onClick={onClose}>{'\u00d7'}</button>
        </div>

        {/* Step indicator dots */}
        {step !== 'creating' && step !== 'done' && (
          <div className="wizard-steps">
            {STEP_ORDER.slice(0, 4).map((s, i) => (
              <div
                key={s}
                className={`wizard-step-dot${s === step ? ' active' : i < stepIndex ? ' completed' : ''}`}
              />
            ))}
          </div>
        )}

        {/* Body */}
        <div className="wizard-body">
          {/* Step 1: Details */}
          {step === 'details' && (
            <div className={slideClass} key="details">
              <div className="form-group">
                <label>Project Name</label>
                <input
                  type="text"
                  value={projectName}
                  onChange={(e) => setProjectName(e.target.value)}
                  placeholder="my-project"
                  autoFocus
                />
              </div>
              <div className="form-group">
                <label>Description (optional)</label>
                <input
                  type="text"
                  value={projectDescription}
                  onChange={(e) => setProjectDescription(e.target.value)}
                  placeholder="A brief description to help pick a template..."
                />
              </div>
              {recommendedTemplate && projectDescription.trim() && (
                <div className="wizard-recommended">
                  Recommended: {recommendedTemplate.icon} {recommendedTemplate.name}
                </div>
              )}
              <div className="form-group">
                <label>Location</label>
                <input
                  type="text"
                  value={location}
                  onChange={(e) => setLocation(e.target.value)}
                  placeholder="~/projects"
                />
              </div>
            </div>
          )}

          {/* Step 2: Template Selection */}
          {step === 'template' && (
            <div className={slideClass} key="template">
              {loading ? (
                <div style={{ textAlign: 'center', padding: 32 }}><div className="spinner" style={{ margin: '0 auto' }} /></div>
              ) : error ? (
                <div style={{ textAlign: 'center', padding: 32, color: 'var(--accent-red)' }}>{error}</div>
              ) : (
                <div className="wizard-template-list">
                  {templates.map((t) => (
                    <button
                      key={t.id}
                      className={`wizard-template-card${selectedTemplate === t.id ? ' selected' : ''}`}
                      onClick={() => setSelectedTemplate(t.id)}
                    >
                      <span className="wizard-template-icon">{t.icon}</span>
                      <div className="wizard-template-info">
                        <div className="wizard-template-name">{t.name}</div>
                        <div className="wizard-template-desc">{t.description}</div>
                        <div className="wizard-template-meta">
                          <span className="wizard-template-badge">{t.type}</span>
                          {t.fileCount !== undefined && (
                            <span className="wizard-template-files">{t.fileCount} files</span>
                          )}
                          {t.score !== undefined && t.score > 0 && (
                            <span className="wizard-template-score">{Math.round(t.score * 100)}% match</span>
                          )}
                          {t.matchedKeywords && t.matchedKeywords.length > 0 && (
                            <span className="wizard-template-keywords">{t.matchedKeywords.join(', ')}</span>
                          )}
                        </div>
                      </div>
                    </button>
                  ))}

                  {/* Blank project card */}
                  <button
                    className={`wizard-template-card blank${selectedTemplate === 'blank' ? ' selected' : ''}`}
                    onClick={() => setSelectedTemplate('blank')}
                  >
                    <span className="wizard-template-icon">{'\u2500'}</span>
                    <div className="wizard-template-info">
                      <div className="wizard-template-name">Blank Project</div>
                      <div className="wizard-template-desc">Empty directory with CLAUDE.md only</div>
                      <div className="wizard-template-meta">
                        <span className="wizard-template-files">1 file</span>
                      </div>
                    </div>
                  </button>
                </div>
              )}
            </div>
          )}

          {/* Step 3: Options */}
          {step === 'options' && (
            <div className={slideClass} key="options">
              <div className="wizard-options-section">
                <h4>Source Control</h4>
                <div className="form-group checkbox">
                  <input type="checkbox" id="wiz-git" checked={initGit} onChange={(e) => setInitGit(e.target.checked)} />
                  <label htmlFor="wiz-git">Initialize Git repository</label>
                </div>
                <div className="form-group checkbox">
                  <input type="checkbox" id="wiz-github" checked={createGitHubRepo} onChange={(e) => setCreateGitHubRepo(e.target.checked)} />
                  <label htmlFor="wiz-github">Create GitHub repository</label>
                </div>
                {createGitHubRepo && (
                  <div className="form-group checkbox" style={{ paddingLeft: 30 }}>
                    <input type="checkbox" id="wiz-private" checked={privateRepo} onChange={(e) => setPrivateRepo(e.target.checked)} />
                    <label htmlFor="wiz-private">Private repository</label>
                  </div>
                )}
              </div>

              {!isBlank && (
                <div className="wizard-options-section">
                  <h4>Build Tools</h4>
                  <div className="form-group checkbox">
                    <input type="checkbox" id="wiz-docker" checked={includeDocker} onChange={(e) => setIncludeDocker(e.target.checked)} />
                    <label htmlFor="wiz-docker">Include Dockerfile</label>
                  </div>
                  <div className="form-group checkbox">
                    <input type="checkbox" id="wiz-ci" checked={includeCI} onChange={(e) => setIncludeCI(e.target.checked)} />
                    <label htmlFor="wiz-ci">Include CI workflow</label>
                  </div>
                  <div className="form-group checkbox">
                    <input type="checkbox" id="wiz-linter" checked={includeLinter} onChange={(e) => setIncludeLinter(e.target.checked)} />
                    <label htmlFor="wiz-linter">Include linter config</label>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Step 4: File Preview */}
          {step === 'preview' && (
            <div className={slideClass} key="preview">
              {previewLoading ? (
                <div style={{ textAlign: 'center', padding: 32 }}><div className="spinner" style={{ margin: '0 auto' }} /></div>
              ) : (
                <>
                  <div style={{ fontSize: 13, color: 'var(--text-secondary)', fontFamily: 'var(--font-mono)', marginBottom: 12 }}>
                    {previewPath}
                  </div>
                  {previewFiles.length > 0 && (
                    <div className="wizard-file-tree">
                      {renderTree(previewTree)}
                    </div>
                  )}
                  <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 8 }}>
                    {previewFiles.length} file{previewFiles.length !== 1 ? 's' : ''} will be created
                  </div>
                </>
              )}
            </div>
          )}

          {/* Step 5: Creating (progress) */}
          {step === 'creating' && progress && (
            <div className="wizard-progress" key="creating">
              {progress.error ? (
                <>
                  <p style={{ color: 'var(--accent-red)', marginBottom: 12 }}>{progress.error}</p>
                  <button className="btn-primary" onClick={onClose} style={{ maxWidth: 140 }}>Close</button>
                </>
              ) : (
                <>
                  <div className="spinner" style={{ margin: '0 auto 16px' }} />
                  <div className="wizard-progress-step">{progress.step}</div>
                  {progress.detail && <div className="wizard-progress-detail">{progress.detail}</div>}
                  <div className="wizard-progress-bar">
                    <div className="usage-bar-track">
                      <div className="usage-bar-fill normal" style={{ width: `${progress.progress}%`, transition: 'width 0.3s ease' }} />
                    </div>
                  </div>
                </>
              )}
            </div>
          )}

          {/* Step 6: Done */}
          {step === 'done' && result && (
            <div className="wizard-done" key="done">
              <div className="wizard-done-icon">{result.success ? '\u2713' : '\u2717'}</div>
              <div className="wizard-done-title">{result.success ? 'Project Created' : 'Creation Failed'}</div>
              {result.projectPath && (
                <div className="wizard-done-path">{result.projectPath}</div>
              )}
              {result.error && <p style={{ color: 'var(--accent-red)', marginBottom: 12 }}>{result.error}</p>}
              {result.success && result.filesCreated.length > 0 && (
                <div className="wizard-done-tree">
                  <div className="wizard-file-tree">
                    {renderTree(doneTree, '', result.projectPath, (filePath) => setViewingFile(filePath))}
                  </div>
                </div>
              )}
              <div className="wizard-done-actions">
                {result.success ? (
                  <>
                    <button className="btn-primary" onClick={handleOpenSession}>
                      Open Session
                    </button>
                    <button className="wizard-footer btn-secondary" onClick={onClose} style={{ background: 'none', border: '1px solid var(--border-color)', color: 'var(--text-secondary)', padding: '8px 16px', borderRadius: 6, cursor: 'pointer', fontSize: 13 }}>
                      Close
                    </button>
                  </>
                ) : (
                  <button className="btn-primary" onClick={onClose}>Close</button>
                )}
              </div>
            </div>
          )}
        </div>

        {/* Footer with navigation buttons */}
        {step !== 'creating' && step !== 'done' && (
          <div className="wizard-footer">
            {step !== 'details' && (
              <button
                className="btn-secondary"
                onClick={() => goTo(STEP_ORDER[stepIndex - 1])}
              >
                Back
              </button>
            )}
            <div style={{ flex: 1 }} />
            {step === 'details' && (
              <button className="btn-primary" onClick={handleNextFromDetails} disabled={!canAdvance}>
                Choose Template
              </button>
            )}
            {step === 'template' && (
              <button className="btn-primary" onClick={handleNextFromTemplate} disabled={!canAdvance}>
                Configure Options
              </button>
            )}
            {step === 'options' && (
              <button className="btn-primary" onClick={handleNextFromOptions}>
                Preview Files
              </button>
            )}
            {step === 'preview' && (
              <button className="btn-primary" onClick={handleCreate} disabled={previewLoading}>
                Create Project
              </button>
            )}
          </div>
        )}
        {viewingFile && (
          <FileViewerModal
            serverId={serverId}
            filePath={viewingFile}
            onClose={() => setViewingFile(null)}
          />
        )}
      </div>
    </div>
  );
}
