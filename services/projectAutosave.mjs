export function startProjectAutosave(save, minutes, onError, timers = globalThis) {
    let saving = false;
    let stopped = false;
    const run = async () => {
        if (saving || stopped) return;
        saving = true;
        try { await save(); } catch (error) { onError(error); }
        finally { saving = false; }
    };
    const timer = timers.setInterval(run, minutes * 60_000);
    return () => { stopped = true; timers.clearInterval(timer); };
}
