import React, { useEffect, useState } from 'react';
import { Download, FolderOpen, Image, RefreshCw, X } from 'lucide-react';
import { Button, EmptyState, Modal } from '../ui-kit';
import { useApp } from '../appStore';
import { formatDate } from '../lib/utils';

export default function PhotosPage() {
    const { toast } = useApp();
    const [photos, setPhotos] = useState([]);
    const [selected, setSelected] = useState(null);
    const [scanning, setScanning] = useState(false);

    const fetchPhotos = () => {
        setScanning(true);
        if (window.api && typeof window.api.invoke === 'function') {
            const res = window.api.invoke('get-photos');
            if (res && typeof res.then === 'function') {
                res.then((list) => {
                    if (Array.isArray(list)) setPhotos(list);
                })
                    .catch(() => {})
                    .finally(() => setTimeout(() => setScanning(false), 750));
            }
        }
        if (window.api && window.api.send) window.api.send('scan-photos');
    };

    useEffect(() => {
        fetchPhotos();
        if (window.api && window.api.onPhotosUpdated) {
            window.api.onPhotosUpdated((list) => {
                if (Array.isArray(list)) setPhotos(list);
            });
        }
    }, []);

    const download = (photo) => {
        if (window.api && window.api.send) {
            window.api.send('download-file', { remotePath: photo.path, name: photo.name });
        }
        toast({ title: 'Downloading', description: photo.name });
    };

    return (
        <div className="flex h-full flex-col">
            <div className="flex items-center gap-2 border-b border-border bg-surface px-5 py-2.5">
                <div>
                    <h3 className="text-[15px] font-semibold">Photos & Media</h3>
                    <p className="text-[12px] text-muted-foreground">Instant access to camera photos on your phone.</p>
                </div>
                <Button className="ml-auto" variant="ghost" onClick={fetchPhotos} disabled={scanning}>
                    <RefreshCw className={scanning ? 'h-4 w-4 animate-spin' : 'h-4 w-4'} />
                    {scanning ? 'Scanning…' : 'Refresh'}
                </Button>
            </div>

            <div className="lb-scroll flex-1 p-5">
                <div className="mx-auto max-w-[1100px]">
                    {photos.length === 0 ? (
                        <EmptyState
                            icon={Image}
                            title="No photos synced yet"
                            description="Photos from your phone's camera folder will appear here after the first scan. Press Refresh or enable photo access on the device."
                        />
                    ) : (
                        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
                            {photos.map((p) => (
                                <button
                                    key={p.id ?? p.path}
                                    onClick={() => setSelected(p)}
                                    className="lb-focus group relative aspect-square overflow-hidden rounded-lg border border-border"
                                >
                                    {p.url ? (
                                        <img src={p.url} alt={p.name} loading="lazy" className="h-full w-full object-cover transition-transform duration-300 group-hover:scale-105" />
                                    ) : (
                                        <div className="flex h-full w-full items-center justify-center bg-surface-2 text-muted-foreground">
                                            <Image className="h-5 w-5 opacity-60" />
                                        </div>
                                    )}
                                    <div className="absolute inset-x-0 bottom-0 flex items-center gap-2 bg-gradient-to-t from-black/70 to-transparent px-2 pb-1.5 pt-6 opacity-0 transition-opacity group-hover:opacity-100">
                                        <span className="truncate text-[11px] text-white">{p.name}</span>
                                        <Download className="ml-auto h-3.5 w-3.5 text-white" />
                                    </div>
                                </button>
                            ))}
                        </div>
                    )}
                </div>
            </div>

            <Modal open={!!selected} onClose={() => setSelected(null)} width="max-w-2xl">
                {selected && (
                <div>
                        <div className="mb-3 flex items-center gap-2">
                            <h3 className="truncate text-[15px] font-semibold">{selected.name}</h3>
                            <span className="ml-auto text-[12px] tabular-nums text-muted-foreground">{selected.size ? `${selected.size} · ` : ''}{formatDate(selected.date)}</span>
                            <Button size="sm" variant="subtle" onClick={() => download(selected)}>
                                <Download className="h-4 w-4" /> Download
                            </Button>
                        </div>
                        {selected.url ? (
                            <img src={selected.url} alt={selected.name} className="max-h-[70vh] w-full rounded-lg object-contain" />
                        ) : (
                            <div className="flex h-[240px] items-center justify-center rounded-lg border border-border bg-surface-2 text-muted-foreground">
                                <FolderOpen className="h-8 w-8 opacity-60" />
                            </div>
                        )}
                    </div>
                )}
                </Modal>
        </div>
    );
}
