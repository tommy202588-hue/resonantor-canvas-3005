import React from 'react';

export interface AlignmentGuide {
    axis: string;
    coordinate: number;
    start: number;
    end: number;
    targetId: string;
}

export default function AlignmentGuides({ guides, scale }: { guides: AlignmentGuide[]; scale: number }) {
    if (!guides.length) return null;
    return (
        <svg aria-hidden="true" data-alignment-guides className="absolute left-0 top-0 pointer-events-none overflow-visible z-[90]" width="1" height="1">
            {guides.map(guide => (
                <line
                    key={guide.axis}
                    data-alignment-axis={guide.axis}
                    data-alignment-target={guide.targetId}
                    x1={guide.axis === 'x' ? guide.coordinate : guide.start}
                    y1={guide.axis === 'y' ? guide.coordinate : guide.start}
                    x2={guide.axis === 'x' ? guide.coordinate : guide.end}
                    y2={guide.axis === 'y' ? guide.coordinate : guide.end}
                    stroke="#22d3ee"
                    strokeWidth={1.5 / scale}
                    strokeDasharray={6 / scale + ' ' + 4 / scale}
                />
            ))}
        </svg>
    );
}
