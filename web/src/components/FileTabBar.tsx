import { OpenFile } from '../services/openFiles';

interface FileTabBarProps {
  files: OpenFile[];
  activeFile: string | null;
  onSelectFile: (path: string) => void;
  onCloseFile: (path: string) => void;
  onCloseAll: () => void;
}

export function FileTabBar({ files, activeFile, onSelectFile, onCloseFile, onCloseAll }: FileTabBarProps) {
  if (files.length === 0) return null;

  return (
    <div className="file-tab-bar">
      <div className="file-tab-bar-tabs">
        {files.map((f) => {
          const fileName = f.path.split('/').pop() || f.path;
          const isActive = f.path === activeFile;
          return (
            <button
              key={f.path}
              className={`file-tab ${isActive ? 'file-tab-active' : ''}`}
              onClick={() => onSelectFile(f.path)}
              title={f.path}
            >
              <span className="file-tab-name">{fileName}</span>
              <span
                className="file-tab-close"
                onClick={(e) => {
                  e.stopPropagation();
                  onCloseFile(f.path);
                }}
              >
                {'\u2715'}
              </span>
            </button>
          );
        })}
      </div>
      {files.length >= 2 && (
        <button className="file-tab-close-all" onClick={onCloseAll}>
          Close All
        </button>
      )}
    </div>
  );
}
