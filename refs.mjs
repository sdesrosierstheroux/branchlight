export function buildRefTree(refs, prefix) {
    const root = { folders: new Map(), refs: [], count: 0 };
    for (const ref of refs) {
        if (!ref.name.startsWith(prefix)) {
            continue;
        }
        const segments = ref.name.slice(prefix.length).split('/');
        let node = root;
        let key = prefix;
        node.count++;
        for (const segment of segments.slice(0, -1)) {
            key += `${segment}/`;
            if (!node.folders.has(segment)) {
                node.folders.set(segment, { name: segment, key, folders: new Map(), refs: [], count: 0 });
            }
            node = node.folders.get(segment);
            node.count++;
        }
        node.refs.push({ ...ref, displayName: segments.at(-1) });
    }
    return root;
}
