const SNAP_DISTANCE_PX = 8;
const ANCHOR_PAIRS = [[0, 0], [0.5, 0.5], [1, 1], [0, 1], [1, 0]];

export function snapNodeDrag(nodes, initialPositions, delta, scale, disabled = false) {
    const unchanged = { delta, guides: [] };
    if (disabled || initialPositions.length !== 1 || !Number.isFinite(scale) || scale <= 0) return unchanged;
    if (Math.hypot(delta.x, delta.y) * scale < 3) return unchanged;
    const initial = initialPositions[0];
    const moving = nodes.find(node => node.id === initial.id);
    if (!moving || moving.source === 'grid') return unchanged;
    const position = { x: initial.x + delta.x, y: initial.y + delta.y };
    const matches = {};
    const threshold = SNAP_DISTANCE_PX / scale;
    for (const axis of ['x', 'y']) {
        const dimension = axis === 'x' ? 'width' : 'height';
        const otherAxis = axis === 'x' ? 'y' : 'x';
        const otherDimension = axis === 'x' ? 'height' : 'width';
        for (const target of nodes) {
            if (target.id === moving.id || target.source === 'grid') continue;
            for (const [movingAnchor, targetAnchor] of ANCHOR_PAIRS) {
                const coordinate = target.position[axis] + target[dimension] * targetAnchor;
                const correction = coordinate - (position[axis] + moving[dimension] * movingAnchor);
                const distance = Math.abs(correction);
                if (distance > threshold) continue;
                const separation = Math.abs(position[otherAxis] + moving[otherDimension] / 2 - target.position[otherAxis] - target[otherDimension] / 2);
                const previous = matches[axis];
                if (!previous || distance < previous.distance || (distance === previous.distance && separation < previous.separation)) {
                    matches[axis] = { target, coordinate, correction, distance, separation };
                }
            }
        }
    }
    const snappedDelta = { x: delta.x + (matches.x?.correction || 0), y: delta.y + (matches.y?.correction || 0) };
    const guides = [];
    for (const axis of ['x', 'y']) {
        const match = matches[axis];
        if (!match) continue;
        const otherAxis = axis === 'x' ? 'y' : 'x';
        const otherDimension = axis === 'x' ? 'height' : 'width';
        const movingStart = initial[otherAxis] + snappedDelta[otherAxis];
        guides.push({
            axis, coordinate: match.coordinate, targetId: match.target.id,
            start: Math.min(movingStart, match.target.position[otherAxis]) - 12 / scale,
            end: Math.max(movingStart + moving[otherDimension], match.target.position[otherAxis] + match.target[otherDimension]) + 12 / scale,
        });
    }
    return { delta: snappedDelta, guides };
}
