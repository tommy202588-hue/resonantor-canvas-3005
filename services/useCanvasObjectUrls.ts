import { useEffect, useLayoutEffect, useRef } from 'react';
import { createObjectUrlTracker } from './canvasObjectUrls.mjs';

export function useCanvasObjectUrls(getHistoryUrls: () => Set<string>, ...roots: unknown[]) {
    const tracker = useRef<ReturnType<typeof createObjectUrlTracker> | null>(null);
    if (!tracker.current) tracker.current = createObjectUrlTracker();
    const disposal = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

    // Runs after useCanvasHistory's layout effect has recorded the last edit.
    // A deleted image must remain valid while undo, history or a preview uses it.
    useLayoutEffect(() => { tracker.current!.update(...roots, getHistoryUrls()); });
    useEffect(() => {
        clearTimeout(disposal.current);
        // React StrictMode / Fast Refresh replays effects without discarding state.
        // Only dispose after a real unmount, not during that synchronous replay.
        return () => { disposal.current = setTimeout(() => tracker.current!.clear(), 0); };
    }, []);
}
