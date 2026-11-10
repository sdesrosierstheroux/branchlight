export function layoutGraph(commits) {
    let lanes = [];
    let color = 0;
    let width = 1;
    const rows = [];
    for (const commit of commits) {
        let lane = lanes.findIndex(item => item.hash === commit.hash);
        if (lane === -1) {
            lane = lanes.length;
            lanes.push({ hash: commit.hash, color: color++ % 6 });
        }
        const before = lanes.map(item => ({ ...item }));
        const nodeColor = lanes[lane].color;
        lanes.splice(lane, 1);
        for (let i = 0; i < commit.parents.length; i++) {
            const parent = commit.parents[i];
            if (!lanes.some(item => item.hash === parent)) {
                lanes.splice(Math.min(lane + i, lanes.length), 0, { hash: parent, color: i === 0 ? nodeColor : color++ % 6 });
            }
        }
        const edges = before.flatMap((item, index) => {
            if (index === lane) {
                return commit.parents.map(parent => {
                    const to = lanes.findIndex(next => next.hash === parent);
                    return { from: lane, to, color: lanes[to].color, fromNode: true };
                });
            }
            return [{ from: index, to: lanes.findIndex(next => next.hash === item.hash), color: item.color, fromNode: false }];
        });
        rows.push({ lane, color: nodeColor, edges, incoming: before.some((item, index) => index === lane && rows.length > 0 && rows[rows.length - 1].outgoing.includes(item.hash)), outgoing: lanes.map(item => item.hash) });
        width = Math.max(width, before.length, lanes.length);
    }
    return { rows, width };
}
