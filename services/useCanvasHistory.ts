import { useCallback, useLayoutEffect, useRef } from 'react';
import { createCanvasHistory, type CanvasHistoryState, type CanvasHistoryScope, type CanvasHistoryOptions } from './canvasHistory.mjs';
import { collectObjectUrls } from './canvasObjectUrls.mjs';

type Pending = { before: CanvasHistoryState; options: CanvasHistoryOptions };
type Gesture = Pending & { ending: boolean };

export function useCanvasHistory(state: CanvasHistoryState) {
    const current = useRef(state);
    current.current = state;
    const history = useRef(createCanvasHistory());
    const pending = useRef<Pending | null>(null);
    const gesture = useRef<Gesture | null>(null);
    const sequence = useRef(0);

    const flush = useCallback(() => {
        if (pending.current) {
            history.current.record(pending.current.before, current.current, pending.current.options);
            pending.current = null;
        } else if (gesture.current) {
            history.current.record(gesture.current.before, current.current, gesture.current.options);
        }
        if (gesture.current) {
            gesture.current.before = current.current;
            if (gesture.current.ending) { gesture.current = null; history.current.breakMerge(); }
        }
    }, []);

    useLayoutEffect(flush);
    useLayoutEffect(() => {
        const boundary = () => history.current.breakMerge();
        document.addEventListener('focusout', boundary);
        return () => document.removeEventListener('focusout', boundary);
    }, []);

    const record = useCallback((options: CanvasHistoryOptions = {}) => {
        if (pending.current) return;
        if (gesture.current) { flush(); gesture.current = null; history.current.breakMerge(); }
        pending.current = { before: current.current, options };
    }, [flush]);

    const beginGesture = useCallback((scope: CanvasHistoryScope) => {
        flush();
        history.current.breakMerge();
        gesture.current = { before: current.current, options: { key: 'gesture-' + (++sequence.current), continuous: true, scope }, ending: false };
    }, [flush]);

    const endGesture = useCallback(() => { if (gesture.current) gesture.current.ending = true; }, []);
    const undo = useCallback(() => {
        flush();
        gesture.current = null;
        const restored = history.current.undo(current.current);
        if (restored) current.current = restored;
        return restored;
    }, [flush]);
    const reset = useCallback((next: CanvasHistoryState) => { pending.current = null; gesture.current = null; history.current.clear(); current.current = next; }, []);

    const getObjectUrls = useCallback((): Set<string> => collectObjectUrls(
        history.current.getObjectUrls(), pending.current?.before.nodes, gesture.current?.before.nodes,
    ), []);

    return { record, beginGesture, endGesture, undo, reset, getObjectUrls };
}
