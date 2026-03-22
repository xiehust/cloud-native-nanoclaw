import { useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import {
  ChevronRight, ChevronDown, Folder, FolderOpen,
  FileText, RefreshCw,
} from 'lucide-react';
import { clsx } from 'clsx';
import { files as filesApi, FileEntry, FileContent } from '../lib/api';

/* ── Helpers ──────────────────────────────────────────────────────── */

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / Math.pow(1024, i);
  return `${value.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    year: 'numeric', month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
}

/* ── TreeNode (recursive) ─────────────────────────────────────────── */

function TreeNode({
  entry,
  depth,
  botId,
  tree,
  expandedFolders,
  selectedFile,
  onToggleFolder,
  onSelectFile,
}: {
  entry: FileEntry;
  depth: number;
  botId: string;
  tree: Record<string, FileEntry[]>;
  expandedFolders: Set<string>;
  selectedFile: string | null;
  onToggleFolder: (key: string) => void;
  onSelectFile: (key: string) => void;
}) {
  const isExpanded = expandedFolders.has(entry.key);
  const isSelected = selectedFile === entry.key;
  const children = tree[entry.key] || [];

  if (entry.isFolder) {
    return (
      <div>
        <button
          onClick={() => onToggleFolder(entry.key)}
          className="flex items-center gap-1.5 w-full text-left py-1.5 pr-3 text-sm text-slate-700 hover:bg-slate-100 transition-colors rounded-md"
          style={{ paddingLeft: depth * 16 + 12 }}
        >
          {isExpanded
            ? <ChevronDown size={14} className="text-slate-400 shrink-0" />
            : <ChevronRight size={14} className="text-slate-400 shrink-0" />
          }
          {isExpanded
            ? <FolderOpen size={15} className="text-amber-500 shrink-0" />
            : <Folder size={15} className="text-amber-500 shrink-0" />
          }
          <span className="truncate">{entry.name}</span>
        </button>
        {isExpanded && children.map((child) => (
          <TreeNode
            key={child.key}
            entry={child}
            depth={depth + 1}
            botId={botId}
            tree={tree}
            expandedFolders={expandedFolders}
            selectedFile={selectedFile}
            onToggleFolder={onToggleFolder}
            onSelectFile={onSelectFile}
          />
        ))}
      </div>
    );
  }

  return (
    <button
      onClick={() => onSelectFile(entry.key)}
      className={clsx(
        'flex items-center gap-1.5 w-full text-left py-1.5 pr-3 text-sm transition-colors rounded-md',
        isSelected
          ? 'bg-accent-50 text-accent-700 font-medium'
          : 'text-slate-700 hover:bg-slate-100',
      )}
      style={{ paddingLeft: depth * 16 + 12 + 18 }}
    >
      <FileText size={15} className={clsx('shrink-0', isSelected ? 'text-accent-500' : 'text-slate-400')} />
      <span className="truncate">{entry.name}</span>
    </button>
  );
}

/* ── FileBrowser ──────────────────────────────────────────────────── */

export default function FileBrowser({ botId }: { botId: string }) {
  const { t } = useTranslation();
  const [tree, setTree] = useState<Record<string, FileEntry[]>>({});
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(new Set());
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [fileContent, setFileContent] = useState<FileContent | null>(null);
  const [loading, setLoading] = useState(true);
  const [contentLoading, setContentLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Load root listing on mount
  useEffect(() => {
    loadFolder('');
  }, [botId]);

  const loadFolder = useCallback(async (prefix: string) => {
    if (prefix === '') setLoading(true);
    setError(null);
    try {
      const result = await filesApi.list(botId, prefix || undefined);
      setTree((prev) => ({ ...prev, [prefix]: result.entries }));
    } catch (err) {
      console.error('Failed to load folder:', err);
      if (prefix === '') setError(t('botDetail.files.failedToLoad'));
    } finally {
      if (prefix === '') setLoading(false);
    }
  }, [botId]);

  const handleToggleFolder = useCallback(async (key: string) => {
    setExpandedFolders((prev) => {
      const next = new Set(prev);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
    // Fetch children if not cached
    if (!tree[key]) {
      await loadFolder(key);
    }
  }, [tree, loadFolder]);

  const handleSelectFile = useCallback(async (key: string) => {
    setSelectedFile(key);
    setContentLoading(true);
    setFileContent(null);
    try {
      const result = await filesApi.content(botId, key);
      setFileContent(result);
    } catch (err) {
      console.error('Failed to load file content:', err);
      setFileContent(null);
    } finally {
      setContentLoading(false);
    }
  }, [botId]);

  const handleRefresh = useCallback(async () => {
    setTree({});
    setExpandedFolders(new Set());
    setSelectedFile(null);
    setFileContent(null);
    await loadFolder('');
  }, [loadFolder]);

  const rootEntries = tree[''] || [];
  const contentLines = fileContent?.content?.split('\n') || [];

  return (
    <div className="flex rounded-xl border border-slate-200 overflow-hidden bg-white" style={{ height: '600px' }}>
      {/* Left: folder tree */}
      <div className="w-72 border-r border-slate-200 overflow-y-auto bg-white flex-shrink-0 flex flex-col">
        {/* Tree header */}
        <div className="flex items-center justify-between px-3 py-2.5 border-b border-slate-100">
          <span className="text-xs font-semibold text-slate-500 uppercase tracking-wider">{t('botDetail.files.explorer')}</span>
          <button
            onClick={handleRefresh}
            className="p-1 text-slate-400 hover:text-slate-600 transition-colors rounded"
            title={t('botDetail.files.refresh')}
          >
            <RefreshCw size={14} />
          </button>
        </div>

        {/* Tree content */}
        <div className="flex-1 overflow-y-auto p-1.5">
          {loading ? (
            <div className="flex items-center justify-center py-12 text-sm text-slate-400">
              {t('common.loading')}
            </div>
          ) : error ? (
            <div className="flex flex-col items-center justify-center py-12 text-sm text-slate-400 gap-2">
              <span>{error}</span>
              <button
                onClick={handleRefresh}
                className="text-accent-600 hover:text-accent-700 font-medium"
              >
                {t('common.retry')}
              </button>
            </div>
          ) : rootEntries.length === 0 ? (
            <div className="flex items-center justify-center py-12 text-sm text-slate-400">
              {t('common.noFilesFound')}
            </div>
          ) : (
            rootEntries.map((entry) => (
              <TreeNode
                key={entry.key}
                entry={entry}
                depth={0}
                botId={botId}
                tree={tree}
                expandedFolders={expandedFolders}
                selectedFile={selectedFile}
                onToggleFolder={handleToggleFolder}
                onSelectFile={handleSelectFile}
              />
            ))
          )}
        </div>
      </div>

      {/* Right: file preview */}
      <div className="flex-1 overflow-hidden bg-slate-50 flex flex-col">
        {contentLoading ? (
          <div className="flex items-center justify-center flex-1 text-sm text-slate-400">
            {t('botDetail.files.loadingFile')}
          </div>
        ) : selectedFile && fileContent ? (
          <>
            {/* File header */}
            <div className="px-4 py-3 border-b border-slate-200 bg-white">
              <p className="text-sm font-medium text-slate-900 font-mono truncate">
                {selectedFile}
              </p>
              <div className="flex items-center gap-3 mt-1 text-xs text-slate-500">
                {fileContent.size != null && (
                  <span>{t('botDetail.files.size', { size: formatBytes(fileContent.size) })}</span>
                )}
                {fileContent.lastModified && (
                  <span>{t('botDetail.files.modified', { date: formatDate(fileContent.lastModified) })}</span>
                )}
                {fileContent.contentType && (
                  <span>{fileContent.contentType}</span>
                )}
              </div>
            </div>

            {/* File content with line numbers */}
            <div className="flex-1 overflow-auto">
              <pre className="font-mono text-sm leading-relaxed">
                <table className="w-full border-collapse">
                  <tbody>
                    {contentLines.map((line, i) => (
                      <tr key={i} className="hover:bg-slate-100/50">
                        <td className="select-none text-right pr-4 pl-4 py-0 text-slate-400 text-xs align-top w-12 border-r border-slate-200 bg-white/60">
                          {i + 1}
                        </td>
                        <td className="pl-4 pr-4 py-0 whitespace-pre-wrap break-all">
                          {line || '\u00A0'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </pre>
            </div>
          </>
        ) : (
          <div className="flex flex-col items-center justify-center flex-1 text-slate-400 gap-3">
            <FileText size={40} strokeWidth={1.5} />
            <p className="text-sm">{t('botDetail.files.selectFile')}</p>
          </div>
        )}
      </div>
    </div>
  );
}
