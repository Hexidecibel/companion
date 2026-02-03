interface FileTabBarProps {
  files: string[];
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
        {files.map((path) => {
          const fileName = path.split('/').pop() || path;
          const isActive = path === activeFile;
          return (
            <button
              key={path}
              className={`file-tab ${isActive ? 'file-tab-active' : ''}`}
              onClick={() => onSelectFile(path)}
              title={path}
            >
              <span className="file-tab-name">{fileName}</span>
              <span
                className="file-tab-close"
                onClick={(e) => {
                  e.stopPropagation();
                  onCloseFile(path);
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
