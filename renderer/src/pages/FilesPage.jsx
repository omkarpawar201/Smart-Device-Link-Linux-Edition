import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
    Archive,
    ArrowUp,
    ChevronRight,
    Download,
    Film,
    Folder,
    FolderPlus,
    Grid,
    HardDrive,
    Image as ImageIcon,
    List,
    Loader,
    Music,
    RefreshCw,
    Trash2,
    UploadCloud
} from 'lucide-react';
import { Button, EmptyState, Panel, SearchBar } from '../ui-kit';
import { useApp } from '../appStore';
import { formatSize } from '../lib/utils';

function fileIcon(file) {
    if (file.isDir) return <Folder className="h-5 w-5 text-warning" />;
    const ext = (file.name.split('.').pop() || '').toLowerCase();
    if (['jpg', 'png', 'gif', 'jpeg', 'webp'].includes(ext)) return <ImageIcon className="h-5 w-5 text-primary" />;
    if (['mp4', 'mkv', 'avi', 'mov'].includes(ext)) return <Film className="h-5 w-5 text-destructive" />;
    if (['mp3', 'wav', 'flac', 'ogg'].includes(ext)) return <Music className="h-5 w-5 text-accent" />;
    if (['zip', 'rar', '7z', 'tar', 'gz'].includes(ext)) return <Archive className="h-5 w-5 text-warning" />;
    return <FileIcon />;
}

function FileIcon() {
    return <div className="flex h-5 w-5 items-center justify-center rounded border border-border text-muted-foreground"><span className="text-[9px] font-bold">FILE</span></div>;
}

export default function FilesPage() {
    const { deviceName, toast } = useApp();
    const [currentPath, setCurrentPath] = useState('/sdcard');
    const [viewMode, setViewMode] = useState('grid');
    const [searchQuery, setSearchQuery] = useState('');
    const [files, setFiles] = useState([]);
    const [isLoading, setIsLoading] = useState(false);
    const [error, setError] = useState('');
    const [storageRoots, setStorageRoots] = useState([]);
    const [creatingFolder, setCreatingFolder] = useState(false);
    const [folderName, setFolderName] = useState('');
    const [isDraggingOver, setIsDraggingOver] = useState(false);
    const dragCounter = useRef(0);
    const [isUploading, setIsUploading] = useState(false);
    const [uploadProgress, setUploadProgress] = useState(0);
    const [uploads, setUploads] = useState([]);

    const loadDirectory = useCallback((newPath) => {
        setCurrentPath(newPath);
        setIsLoading(true);
        setError('');
        if (window.api && window.api.invoke) {
            window.api
                .invoke('fetch-files', { path: newPath })
                .then((items) => {
                    if (Array.isArray(items)) {
                        setFiles(items);
                        setError('');
                    } else {
                        setError('Could not read this folder.');
                    }
                })
                .catch((err) => setError('Could not read this folder: ' + (err?.message || 'unknown error')))
                .finally(() => setIsLoading(false));
        } else {
            setIsLoading(false);
        }
    }, []);

    useEffect(() => {
        let cancelled = false;
        (async () => {
            let initialPath = '/sdcard';
            if (window.api && window.api.invoke) {
                try {
                    const roots = await window.api.invoke('list-storage-roots');
                    if (!cancelled && Array.isArray(roots) && roots.length) {
                        setStorageRoots(roots);
                        const preferred = roots.find((r) => r.id === 'internal') || roots[0];
                        initialPath = preferred.path;
                    }
                } catch (e) {}
            }
            if (!cancelled) loadDirectory(initialPath);
        })();
        return () => {
            cancelled = true;
        };
    }, [loadDirectory]);

    useEffect(() => {
        if (!window.api || !window.api.onUploadProgress) return undefined;
        return window.api.onUploadProgress(({ name, progress, done, failed }) => {
            setUploads((prev) =>
                prev.map((u) => (u.name === name ? { ...u, transferred: u.size * progress, done: !!done, failed: !!failed } : u))
            );
        });
    }, []);

    useEffect(() => {
        if (!uploads.length) return;
        const totalBytes = uploads.reduce((s, u) => s + u.size, 0);
        const transferredBytes = uploads.reduce((s, u) => s + u.transferred, 0);
        setUploadProgress(totalBytes > 0 ? Math.floor((transferredBytes / totalBytes) * 100) : 0);
        if (uploads.every((u) => u.done)) {
            const timer = setTimeout(() => {
                setIsUploading(false);
                setUploads([]);
                setUploadProgress(0);
            }, 800);
            return () => clearTimeout(timer);
        }
        return undefined;
    }, [uploads]);

    const currentRoot = storageRoots.find((r) => currentPath === r.path || currentPath.startsWith(r.path + '/')) || null;

    const goUp = () => {
        if (!currentPath || currentPath === '/') return;
        if (currentRoot && currentPath === currentRoot.path) return;
        loadDirectory(currentPath.substring(0, currentPath.lastIndexOf('/')) || '/');
    };

    const download = (file) => {
        if (window.api && window.api.send) window.api.send('download-file', { remotePath: file.path, name: file.name });
        toast({ title: 'Downloading', description: file.name });
    };

    const remove = (file) => {
        setFiles((prev) => prev.filter((f) => f.path !== file.path));
        if (window.api && window.api.send) window.api.send('delete-file', { remotePath: file.path, isDir: file.isDir });
    };

    const newFolder = async (e) => {
        e.preventDefault();
        const safeName = folderName.trim().replace(/[/\\]/g, '_');
        if (!safeName) return;
        if (window.api && window.api.invoke) {
            try {
                const res = await window.api.invoke('create-directory', { path: `${currentPath}/${safeName}` });
                if (res && res.ok) {
                    setCreatingFolder(false);
                    setFolderName('');
                    loadDirectory(currentPath);
                }
            } catch (err) {}
        }
    };

    const onDragEnter = (e) => {
        e.preventDefault();
        e.stopPropagation();
        dragCounter.current += 1;
        setIsDraggingOver(true);
    };
    const onDragOver = (e) => {
        e.preventDefault();
        e.stopPropagation();
    };
    const onDragLeave = (e) => {
        e.preventDefault();
        e.stopPropagation();
        dragCounter.current -= 1;
        if (dragCounter.current <= 0) {
            dragCounter.current = 0;
            setIsDraggingOver(false);
        }
    };
    const onDrop = (e) => {
        e.preventDefault();
        e.stopPropagation();
        dragCounter.current = 0;
        setIsDraggingOver(false);
        const droppedFiles = Array.from(e.dataTransfer.files);
        if (!droppedFiles.length) return;
        setUploads(droppedFiles.map((file) => ({ name: file.name, size: file.size || 0, transferred: 0, done: false })));
        setIsUploading(true);
        setUploadProgress(0);
        droppedFiles.forEach((file) => {
            const localPath = window.api && window.api.getPathForFile ? window.api.getPathForFile(file) : file.path || '';
            setFiles((prev) => [{ name: file.name, isDir: false, size: file.size, path: `${currentPath}/${file.name}` }, ...prev]);
            if (localPath && window.api && window.api.send) {
                window.api.send('upload-file', { localPath, remoteDirectory: currentPath });
            }
        });
    };

    const pathParts = currentPath.split('/').filter(Boolean);
    const rootParts = (currentRoot?.path || '').split('/').filter(Boolean);
    const crumbParts =
        rootParts.length && (currentPath === currentRoot.path || currentPath.startsWith(currentRoot.path + '/'))
            ? pathParts.slice(rootParts.length)
            : pathParts;

    const filteredFiles = useMemo(
        () => files.filter((f) => f.name.toLowerCase().includes(searchQuery.toLowerCase())),
        [files, searchQuery]
    );

    return (
        <div className="flex h-full flex-col">
            <div className="flex flex-wrap items-center gap-2 border-b border-border bg-surface px-5 py-2.5">
                <div>
                    <h3 className="text-[15px] font-semibold">File Manager</h3>
                    <p className="text-[12px] text-muted-foreground">Browse storage on {deviceName}. Drag & drop files anywhere to upload.</p>
                </div>
                <div className="ml-auto flex items-center gap-2">
                    {creatingFolder ? (
                        <form onSubmit={newFolder} className="flex items-center gap-1.5">
                            <input
                                autoFocus
                                value={folderName}
                                onChange={(e) => setFolderName(e.target.value)}
                                placeholder="Folder name"
                                className="w-[150px] rounded-md border border-border bg-surface-2 px-2.5 py-1.5 text-[12.5px] outline-none focus:border-primary"
                            />
                            <Button size="sm" variant="primary">Create</Button>
                            <Button size="sm" variant="ghost" onClick={() => { setCreatingFolder(false); setFolderName(''); }}>Cancel</Button>
                        </form>
                    ) : (
                        <Button size="sm" variant="subtle" onClick={() => { setCreatingFolder(true); setFolderName(''); }}>
                            <FolderPlus className="h-4 w-4" /> New folder
                        </Button>
                    )}
                    <div className="flex overflow-hidden rounded-md border border-border">
                        <button onClick={() => setViewMode('grid')} className={`px-2.5 py-1.5 ${viewMode === 'grid' ? 'bg-primary/15 text-primary' : 'text-muted-foreground'}`}>
                            <Grid className="h-4 w-4" />
                        </button>
                        <button onClick={() => setViewMode('list')} className={`px-2.5 py-1.5 ${viewMode === 'list' ? 'bg-primary/15 text-primary' : 'text-muted-foreground'}`}>
                            <List className="h-4 w-4" />
                        </button>
                    </div>
                </div>
            </div>

            <div className="flex h-full flex-col gap-3 p-5">
                <Panel className="flex items-center gap-2 px-3 py-2">
                    <Button size="sm" variant="ghost" onClick={goUp} aria-label="Up"><ArrowUp className="h-4 w-4" /></Button>
                    <Button size="sm" variant="ghost" onClick={() => loadDirectory(currentPath)} aria-label="Refresh"><RefreshCw className="h-4 w-4" /></Button>
                    <HardDrive className="h-4 w-4 text-primary" />
                    <button onClick={() => loadDirectory(currentRoot ? currentRoot.path : '/sdcard')} className="text-[12.5px] font-medium text-primary">
                        {currentRoot ? currentRoot.name : 'Internal Storage'}
                    </button>
                    {crumbParts.map((part, index) => {
                        const subPath = '/' + pathParts.slice(0, rootParts.length + index + 1).join('/');
                        return (
                            <React.Fragment key={subPath}>
                                <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
                                <button
                                    onClick={() => loadDirectory(subPath)}
                                    className={`text-[12.5px] ${index === crumbParts.length - 1 ? 'font-semibold text-foreground' : 'text-muted-foreground hover:text-foreground'}`}
                                >
                                    {part}
                                </button>
                            </React.Fragment>
                        );
                    })}
                    <SearchBar value={searchQuery} onChange={setSearchQuery} placeholder="Search files…" className="ml-auto w-[220px]" />
                </Panel>

                {isUploading && (
                    <Panel className="border-primary/30 bg-primary/5 p-3.5">
                        <div className="flex items-center gap-3">
                            <UploadCloud className="h-5 w-5 text-primary" />
                            <div className="flex-1">
                                <div className="text-[13px] font-semibold">Uploading to phone ({uploadProgress}%)</div>
                                <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-surface-3">
                                    <div className="h-full rounded-full bg-primary transition-all" style={{ width: `${uploadProgress}%` }} />
                                </div>
                            </div>
                        </div>
                        <div className="mt-2 space-y-1.5">
                            {uploads.map((u) => {
                                const pct = u.size > 0 ? Math.floor((u.transferred / u.size) * 100) : u.done ? 100 : 0;
                                return (
                                    <div key={u.name} className="flex items-center gap-2 text-[11.5px]">
                                        <span className={`w-[200px] truncate ${u.failed ? 'text-destructive' : 'text-muted-foreground'}`}>{u.name}</span>
                                        <div className="h-1 flex-1 overflow-hidden rounded-full bg-surface-3">
                                            <div className={`h-full rounded-full ${u.failed ? 'bg-destructive' : u.done ? 'bg-success' : 'bg-primary'}`} style={{ width: `${pct}%` }} />
                                        </div>
                                        <span className="w-12 text-right tabular-nums text-muted-foreground">{u.failed ? 'Failed' : u.done ? 'Done' : `${pct}%`}</span>
                                    </div>
                                );
                            })}
                        </div>
                    </Panel>
                )}

                <div className="lb-scroll flex-1" onDragEnter={onDragEnter} onDragOver={onDragOver} onDragLeave={onDragLeave} onDrop={onDrop}>
                    {isLoading ? (
                        <Panel className="flex h-full items-center justify-center gap-3 text-muted-foreground">
                            <Loader className="h-5 w-5 animate-spin text-primary" />
                            Loading {currentPath}…
                        </Panel>
                    ) : error ? (
                        <Panel className="flex h-full flex-col items-center justify-center gap-3 p-8">
                            <div className="text-[13px] text-destructive">{error}</div>
                            <div className="text-[12.5px] text-muted-foreground">Make sure the SFTP plugin is running on {deviceName} and it is connected.</div>
                            <Button variant="subtle" onClick={() => loadDirectory(currentPath)}><RefreshCw className="h-4 w-4" /> Retry</Button>
                        </Panel>
                    ) : filteredFiles.length === 0 ? (
                        <Panel className="flex h-full items-center justify-center">
                            <EmptyState
                                icon={Folder}
                                title={searchQuery ? 'No matching files' : 'This folder is empty'}
                                description={searchQuery ? 'Try a different search term.' : 'Drag & drop files here to upload them to your phone.'}
                            />
                        </Panel>
                    ) : viewMode === 'grid' ? (
                        <div className="grid grid-cols-[repeat(auto-fill,minmax(170px,1fr))] gap-3">
                            {filteredFiles.map((file) => (
                                <div
                                    key={file.path}
                                    onDoubleClick={() => file.isDir && loadDirectory(file.path)}
                                    className="lb-focus group flex cursor-pointer flex-col items-center gap-2.5 rounded-lg border border-border bg-surface p-4 text-center transition-colors hover:border-primary/40"
                                >
                                    {fileIcon(file)}
                                    <div className="w-full">
                                        <div className="truncate text-[12.5px] font-medium">{file.name}</div>
                                        <div className="text-[11px] text-muted-foreground">{file.isDir ? 'Folder' : formatSize(file.size)}</div>
                                    </div>
                                    {!file.isDir && (
                                        <div className="flex gap-1.5">
                                            <Button size="sm" variant="ghost" onClick={() => download(file)} aria-label="Download"><Download className="h-3.5 w-3.5" /></Button>
                                            <Button size="sm" variant="ghost" onClick={() => remove(file)} aria-label="Delete"><Trash2 className="h-3.5 w-3.5 text-destructive" /></Button>
                                        </div>
                                    )}
                                </div>
                            ))}
                        </div>
                    ) : (
                        <Panel className="divide-y divide-border">
                            {filteredFiles.map((file) => (
                                <div
                                    key={file.path}
                                    onDoubleClick={() => file.isDir && loadDirectory(file.path)}
                                    className="flex cursor-pointer items-center gap-3 px-3.5 py-2.5 hover:bg-surface-2"
                                >
                                    {fileIcon(file)}
                                    <span className="min-w-0 flex-1 truncate text-[13px] font-medium">{file.name}</span>
                                    <span className="w-16 text-right text-[12px] tabular-nums text-muted-foreground">{file.isDir ? 'Folder' : formatSize(file.size)}</span>
                                    {!file.isDir && (
                                        <div className="flex gap-1.5">
                                            <Button size="sm" variant="ghost" onClick={() => download(file)} aria-label="Download"><Download className="h-3.5 w-3.5" /></Button>
                                            <Button size="sm" variant="ghost" onClick={() => remove(file)} aria-label="Delete"><Trash2 className="h-3.5 w-3.5 text-destructive" /></Button>
                                        </div>
                                    )}
                                </div>
                            ))}
                        </Panel>
                    )}
                </div>
            </div>

            {isDraggingOver && (
                <div className="pointer-events-none absolute inset-0 z-50 flex flex-col items-center justify-center gap-3 rounded-xl border-2 border-dashed border-primary bg-popover/90 backdrop-blur-md">
                    <UploadCloud className="h-12 w-12 text-primary" />
                    <div className="text-[16px] font-semibold">Drop files to upload to {currentPath}</div>
                    <div className="text-[12.5px] text-muted-foreground">Files will be transferred via SFTP</div>
                </div>
            )}
        </div>
    );
}
