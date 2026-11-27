import { collectObjectUrls } from './canvasObjectUrls.mjs';

const collections = ['nodes', 'connections', 'groups'];
const has = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const plain = value => value !== null && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype;
const clone = value => Array.isArray(value) ? value.map(clone) : plain(value) ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, clone(item)])) : value;
const equal = (first, second) => {
    if (Object.is(first, second)) return true;
    if (Array.isArray(first) && Array.isArray(second)) return first.length === second.length && first.every((item, index) => equal(item, second[index]));
    if (!plain(first) || !plain(second)) return false;
    const keys = Object.keys(first).filter(key => first[key] !== undefined);
    return keys.length === Object.keys(second).filter(key => second[key] !== undefined).length && keys.every(key => equal(first[key], second[key]));
};
const field = (entity, key) => ({ exists: has(entity, key), value: clone(entity[key]) });
const selection = state => ({ selectedNodeIds: [...state.selectedNodeIds], selectedGroupId: state.selectedGroupId, selectedConnectionId: state.selectedConnectionId });

function changesBetween(before, after, scope) {
    const changes = [];
    for (const collection of collections) {
        if (scope && !scope[collection]) continue;
        const allowed = scope?.[collection];
        const previous = new Map(before[collection].map((entity, index) => [entity.id, { entity, index }]));
        const next = new Map(after[collection].map((entity, index) => [entity.id, { entity, index }]));
        for (const id of new Set([...previous.keys(), ...next.keys()])) {
            if (allowed && !allowed.ids.includes(id)) continue;
            const original = previous.get(id);
            const updated = next.get(id);
            if (!original || !updated) {
                changes.push({ collection, id, kind: original ? 'remove' : 'add', index: (original || updated).index, entity: clone((original || updated).entity) });
                continue;
            }
            if (original.entity === updated.entity) continue;
            const fields = [];
            for (const key of new Set([...Object.keys(original.entity), ...Object.keys(updated.entity)])) {
                if (key === 'id' || (allowed?.fields && !allowed.fields.includes(key))) continue;
                if (equal(original.entity[key], updated.entity[key])) continue;
                fields.push({ key, before: field(original.entity, key), after: field(updated.entity, key) });
            }
            if (fields.length) changes.push({ collection, id, kind: 'update', fields });
        }
    }
    return changes;
}

function mergeChanges(previous, next) {
    const merged = new Map(previous.map(change => [change.collection + ':' + change.id, clone(change)]));
    for (const change of next) {
        const key = change.collection + ':' + change.id;
        const existing = merged.get(key);
        if (!existing) { merged.set(key, change); continue; }
        const fields = new Map(existing.fields.map(item => [item.key, item]));
        for (const item of change.fields) {
            const original = fields.get(item.key);
            fields.set(item.key, original ? { ...item, before: original.before } : item);
        }
        existing.fields = [...fields.values()].filter(item => !equal(item.before, item.after));
        if (!existing.fields.length) merged.delete(key);
    }
    return [...merged.values()];
}

function restoreRemovedNode(node) {
    if (node.status !== 'loading') return node;
    return { ...node, status: 'error', progress: 0, taskId: undefined, startTime: undefined, errorDetails: '节点已恢复。此前任务已中断，请确认内容后重新生成。' };
}

function applyUndo(state, entry) {
    const restored = { ...state };
    for (const collection of collections) {
        let entities = state[collection];
        for (const change of entry.changes.filter(item => item.collection === collection)) {
            const index = entities.findIndex(entity => entity.id === change.id);
            if (change.kind === 'add') {
                if (index >= 0) entities = entities.filter(entity => entity.id !== change.id);
            } else if (change.kind === 'remove') {
                if (index >= 0) continue;
                const entity = clone(change.entity);
                entities = [...entities];
                entities.splice(Math.min(change.index, entities.length), 0, collection === 'nodes' ? restoreRemovedNode(entity) : entity);
            } else if (index >= 0) {
                const entity = { ...entities[index] };
                let changed = false;
                for (const item of change.fields) {
                    if (!equal(entity[item.key], item.after.value)) continue;
                    if (item.before.exists) entity[item.key] = clone(item.before.value);
                    else delete entity[item.key];
                    changed = true;
                }
                if (changed) { entities = [...entities]; entities[index] = entity; }
            }
        }
        restored[collection] = entities;
    }
    const nodeIds = new Set(restored.nodes.map(node => node.id));
    const groupIds = new Set(restored.groups.map(group => group.id));
    restored.connections = restored.connections.filter(connection => nodeIds.has(connection.fromNodeId) && nodeIds.has(connection.toNodeId));
    restored.nodes = restored.nodes.map(node => node.groupId && !groupIds.has(node.groupId) ? { ...node, groupId: undefined } : node);
    return {
        ...restored,
        selectedNodeIds: entry.selection.selectedNodeIds.filter(id => nodeIds.has(id)),
        selectedGroupId: groupIds.has(entry.selection.selectedGroupId) ? entry.selection.selectedGroupId : null,
        selectedConnectionId: restored.connections.some(connection => connection.id === entry.selection.selectedConnectionId) ? entry.selection.selectedConnectionId : null,
    };
}

export function createCanvasHistory({ limit = 20, mergeWindowMs = 750, now = Date.now } = {}) {
    let entries = [];
    let mergeAllowed = false;
    return {
        get size() { return entries.length; },
        getObjectUrls() { return collectObjectUrls(entries); },
        clear() { entries = []; mergeAllowed = false; },
        breakMerge() { mergeAllowed = false; },
        record(before, after, { key = '', continuous = false, scope } = {}) {
            const changes = changesBetween(before, after, scope);
            if (!changes.length) return;
            const time = now();
            const previous = entries.at(-1);
            const canMerge = key && mergeAllowed && previous?.key === key && (continuous || time - previous.time <= mergeWindowMs)
                && previous.changes.every(change => change.kind === 'update') && changes.every(change => change.kind === 'update');
            if (canMerge) {
                previous.changes = mergeChanges(previous.changes, changes);
                previous.time = time;
                if (!previous.changes.length) entries.pop();
            } else {
                entries.push({ changes, key, time, selection: selection(before) });
                entries = entries.slice(-limit);
            }
            mergeAllowed = Boolean(key);
        },
        undo(state) {
            mergeAllowed = false;
            while (entries.length) {
                const restored = applyUndo(state, entries.pop());
                if (collections.some(collection => !equal(restored[collection], state[collection]))) return restored;
            }
            return null;
        },
    };
}
