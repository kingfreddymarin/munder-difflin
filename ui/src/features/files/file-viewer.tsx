import * as React from 'react';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import { FolderOpen, File, Folder, ChevronRight, Save, Eye, Pencil, X, Loader2, AlertCircle } from 'lucide-react';
import { Button } from '@/components/animate-ui/components/buttons/button';
import { Tile } from '@/components/app/tile';
import { findBridge } from '@/data/bridge';
import type { DirEntry } from '@/data/electron-api';
import { cn } from '@/lib/utils';

marked.setOptions({ breaks: true });

export const MAX_EDIT_BYTES = 2 * 1024 * 1024; // 2 MB text limit

export function bytes(n: number) {
  if (n < 1024) return `${n} B`;
  if (n < 1048576) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1048576).toFixed(1)} MB`;
}

export function isMarkdown(name: string) {
  return /\.mdx?$/i.test(name);
}

export function isTextFile(name: string) {
  return /\.(txt|md|mdx|ts|tsx|js|jsx|mjs|cjs|json|jsonl|yaml|yml|toml|env|sh|bash|zsh|fish|py|rb|go|rs|java|c|cpp|h|hpp|css|scss|html|astro|svelte|vue|xml|csv|log|gitignore|gitattributes|npmrc|nvmrc|prettierrc|eslintrc|editorconfig|lock)$/i.test(name) || !name.includes('.');
}

// ─── Directory browser ────────────────────────────────────────────────────────

interface BrowserProps {
  root: string;
  rel: string;
  onNavigate: (rel: string) => void;
  onOpenFile: (rel: string, name: string) => void;
  selectedFile: string | null;
}

function DirBrowser({ root, rel, onNavigate, onOpenFile, selectedFile }: BrowserProps) {
  const [entries, setEntries] = React.useState<DirEntry[] | null>(null);
  const [err, setErr] = React.useState<string | null>(null);
  const bridge = findBridge();

  React.useEffect(() => {
    if (!bridge?.listDir) { setErr('File system not available in this environment.'); return; }
    setEntries(null);
    setErr(null);
    bridge.listDir(root, rel).then((r) => {
      if (r.ok) {
        const sorted = [...r.entries].sort((a, b) => {
          if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
          return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
        });
        setEntries(sorted);
      } else {
        setErr(r.error);
      }
    }).catch((e) => setErr(String(e)));
  }, [root, rel]); // eslint-disable-line react-hooks/exhaustive-deps

  const segments = rel.split('/').filter(Boolean);

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-1">
      {/* breadcrumb */}
      <nav aria-label="directory path" className="flex flex-wrap items-center gap-0.5 text-xs text-muted-foreground">
        <button className="hover:text-foreground truncate max-w-[8rem]" onClick={() => onNavigate('')} title={root}>
          {root.split('/').at(-1) ?? root}
        </button>
        {segments.map((seg, i) => (
          <React.Fragment key={i}>
            <ChevronRight className="size-3 shrink-0" />
            <button
              className="hover:text-foreground truncate max-w-[8rem]"
              onClick={() => onNavigate(segments.slice(0, i + 1).join('/'))}
            >
              {seg}
            </button>
          </React.Fragment>
        ))}
      </nav>

      {/* listing */}
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto overscroll-contain" role="listbox" aria-label="files">
        {rel && (
          <button
            role="option" aria-selected={false}
            className="flex items-center gap-1.5 rounded px-2 py-1 text-sm text-muted-foreground hover:bg-accent hover:text-accent-foreground"
            onClick={() => onNavigate(segments.slice(0, -1).join('/'))}
          >
            <Folder className="size-3.5 shrink-0 opacity-60" />
            ..
          </button>
        )}
        {entries === null && !err && (
          <div className="flex items-center gap-2 px-2 py-2 text-xs text-muted-foreground">
            <Loader2 className="size-3 animate-spin" /> Loading…
          </div>
        )}
        {err && (
          <div className="flex items-center gap-2 px-2 py-2 text-xs text-destructive">
            <AlertCircle className="size-3.5 shrink-0" /> {err}
          </div>
        )}
        {entries?.map((e) => {
          const entryRel = rel ? `${rel}/${e.name}` : e.name;
          const isSelected = !e.isDir && selectedFile === entryRel;
          return (
            <button
              key={e.name}
              role="option"
              aria-selected={isSelected}
              className={cn(
                'flex items-center gap-1.5 rounded px-2 py-1 text-sm hover:bg-accent hover:text-accent-foreground text-left',
                isSelected && 'bg-accent text-accent-foreground font-medium',
              )}
              onClick={() => e.isDir ? onNavigate(entryRel) : onOpenFile(entryRel, e.name)}
            >
              {e.isDir
                ? <Folder className="size-3.5 shrink-0 text-muted-foreground" />
                : <File className="size-3.5 shrink-0 text-muted-foreground" />}
              <span className="truncate flex-1">{e.name}</span>
              {!e.isDir && <span className="text-muted-foreground text-xs shrink-0">{bytes(e.size)}</span>}
            </button>
          );
        })}
        {entries?.length === 0 && (
          <p className="px-2 py-2 text-xs text-muted-foreground italic">Empty directory</p>
        )}
      </div>
    </div>
  );
}

// ─── File editor / viewer ─────────────────────────────────────────────────────

interface EditorProps {
  root: string;
  fileRel: string;
  fileName: string;
  onClose: () => void;
}

function FileEditor({ root, fileRel, fileName, onClose }: EditorProps) {
  const bridge = findBridge();
  const [content, setContent] = React.useState<string | null>(null);
  const [draft, setDraft] = React.useState<string>('');
  const [err, setErr] = React.useState<string | null>(null);
  const [saving, setSaving] = React.useState(false);
  const [saved, setSaved] = React.useState(false);
  const [mode, setMode] = React.useState<'edit' | 'preview'>('edit');
  const [tooLarge, setTooLarge] = React.useState(false);

  const isMd = isMarkdown(fileName);
  const isText = isTextFile(fileName);
  const dirty = draft !== content;

  React.useEffect(() => {
    setContent(null);
    setDraft('');
    setErr(null);
    setSaved(false);
    setMode('edit');
    setTooLarge(false);
    if (!bridge?.readFile) { setErr('File reading not available in this environment.'); return; }
    if (!isText) { setErr(`Binary or unsupported file type. Use Reveal in Finder to open "${fileName}" externally.`); return; }
    bridge.readFile(root, fileRel).then((r) => {
      if (r.ok) {
        if (r.size > MAX_EDIT_BYTES) {
          setTooLarge(true);
          setContent(r.content.slice(0, 4000) + '\n\n… (file too large to edit — showing first 4 KB)');
          setDraft(r.content.slice(0, 4000) + '\n\n… (file too large to edit — showing first 4 KB)');
        } else {
          setContent(r.content);
          setDraft(r.content);
        }
      } else {
        setErr(r.error);
      }
    }).catch((e) => setErr(String(e)));
  }, [root, fileRel]); // eslint-disable-line react-hooks/exhaustive-deps

  async function save() {
    if (!bridge?.writeFile || tooLarge) return;
    setSaving(true);
    try {
      const r = await bridge.writeFile(root, fileRel, draft);
      if (r.ok) {
        setContent(draft);
        setSaved(true);
        setTimeout(() => setSaved(false), 2000);
      } else {
        setErr(r.error);
      }
    } catch (e) {
      setErr(String(e));
    } finally {
      setSaving(false);
    }
  }

  const mdHtml = React.useMemo(() => {
    if (!isMd || mode !== 'preview' || draft === null) return null;
    const raw = marked.parse(draft) as string;
    return { __html: DOMPurify.sanitize(raw) };
  }, [isMd, mode, draft]);

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2">
      {/* toolbar */}
      <div className="flex shrink-0 items-center gap-2 flex-wrap">
        <span className="text-sm font-medium truncate flex-1 min-w-0">{fileName}</span>
        {isMd && (
          <div className="flex rounded-md border overflow-hidden text-xs">
            <button
              className={cn('px-2 py-1 flex items-center gap-1', mode === 'edit' ? 'bg-primary text-primary-foreground' : 'hover:bg-accent')}
              onClick={() => setMode('edit')}
            >
              <Pencil className="size-3" /> Edit
            </button>
            <button
              className={cn('px-2 py-1 flex items-center gap-1', mode === 'preview' ? 'bg-primary text-primary-foreground' : 'hover:bg-accent')}
              onClick={() => setMode('preview')}
            >
              <Eye className="size-3" /> Preview
            </button>
          </div>
        )}
        {dirty && !tooLarge && bridge?.writeFile && (
          <Button size="sm" onClick={save} disabled={saving}>
            {saving ? <Loader2 className="size-3 animate-spin" /> : <Save className="size-3" />}
            {saving ? 'Saving…' : 'Save'}
          </Button>
        )}
        {saved && <span className="text-xs text-emerald-500">Saved</span>}
        {err && (
          <span className="text-xs text-destructive flex items-center gap-1">
            <AlertCircle className="size-3 shrink-0" /> {err}
          </span>
        )}
        <button className="ml-auto text-muted-foreground hover:text-foreground" onClick={onClose} aria-label="close">
          <X className="size-4" />
        </button>
      </div>

      {/* content */}
      <div className="flex min-h-0 flex-1 overflow-hidden rounded-lg border">
        {content === null && !err && (
          <div className="flex items-center gap-2 p-4 text-xs text-muted-foreground">
            <Loader2 className="size-3 animate-spin" /> Loading…
          </div>
        )}
        {err && !content && (
          <div className="flex items-center gap-2 p-4 text-xs text-destructive">
            <AlertCircle className="size-3.5 shrink-0" /> {err}
          </div>
        )}
        {content !== null && mode === 'preview' && mdHtml && (
          <div
            className="md-prose h-full w-full overflow-y-auto overscroll-contain p-4"
            dangerouslySetInnerHTML={mdHtml}
          />
        )}
        {content !== null && mode === 'edit' && (
          <textarea
            className="h-full w-full resize-none bg-transparent p-3 font-mono text-xs outline-none"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            readOnly={tooLarge || !bridge?.writeFile}
            aria-label={`Edit ${fileName}`}
            spellCheck={false}
          />
        )}
      </div>
    </div>
  );
}

// ─── Public export ────────────────────────────────────────────────────────────

export function FileViewerFeature() {
  const bridge = findBridge();
  const [root, setRoot] = React.useState<string | null>(null);
  const [dirRel, setDirRel] = React.useState('');
  const [openFile, setOpenFile] = React.useState<{ rel: string; name: string } | null>(null);

  async function pickFolder() {
    if (!bridge?.chooseFolder) return;
    const r = await bridge.chooseFolder();
    if (r.ok) { setRoot(r.path); setDirRel(''); setOpenFile(null); }
  }

  async function pickFile() {
    if (!bridge?.attachFiles) return;
    const r = await bridge.attachFiles();
    if (!r.ok || r.files.length === 0) return;
    const f = r.files[0];
    // derive root as the file's parent directory, rel as the filename
    const sep = f.path.lastIndexOf('/');
    const fileRoot = sep >= 0 ? f.path.slice(0, sep) : f.path;
    const fileName = sep >= 0 ? f.path.slice(sep + 1) : f.path;
    setRoot(fileRoot);
    setDirRel('');
    setOpenFile({ rel: fileName, name: fileName });
  }

  return (
    <div className="flex min-h-0 flex-1 gap-3 overflow-hidden">
      {/* left: browser */}
      <Tile
        title="Browser"
        className="w-56 shrink-0"
        actions={
          <div className="flex gap-1">
            <Button size="sm" variant="ghost" onClick={pickFolder} title="Open folder" disabled={!bridge?.chooseFolder}>
              <FolderOpen className="size-3.5" />
            </Button>
            <Button size="sm" variant="ghost" onClick={pickFile} title="Open file" disabled={!bridge?.attachFiles}>
              <File className="size-3.5" />
            </Button>
          </div>
        }
        scrollLabel="file browser"
      >
        {!root && (
          <div className="flex flex-col items-center gap-3 py-6 text-center">
            <FolderOpen className="size-8 text-muted-foreground opacity-40" />
            <p className="text-xs text-muted-foreground">Open a folder to browse files</p>
            {bridge?.chooseFolder ? (
              <Button size="sm" onClick={pickFolder}>Open folder</Button>
            ) : (
              <p className="text-xs text-muted-foreground italic">Not available in this environment</p>
            )}
          </div>
        )}
        {root && (
          <DirBrowser
            root={root}
            rel={dirRel}
            onNavigate={setDirRel}
            onOpenFile={(rel, name) => setOpenFile({ rel, name })}
            selectedFile={openFile?.rel ?? null}
          />
        )}
      </Tile>

      {/* right: viewer / editor */}
      <Tile title="Editor" className="flex-1" scrollLabel="file content">
        {!openFile && (
          <div className="flex flex-col items-center gap-2 py-10 text-center">
            <File className="size-8 text-muted-foreground opacity-30" />
            <p className="text-xs text-muted-foreground">Select a file to view or edit it</p>
          </div>
        )}
        {openFile && root && (
          <FileEditor
            root={root}
            fileRel={openFile.rel}
            fileName={openFile.name}
            onClose={() => setOpenFile(null)}
          />
        )}
      </Tile>
    </div>
  );
}
