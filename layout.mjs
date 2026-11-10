export const layoutLimits = {
    sidebarWidth: [160, 600],
    inspectorWidth: [200, 800],
    worktreesHeight: [84, 1200],
};

export function cleanLayout(input) {
    const result = {};
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
        return result;
    }
    for (const [key, [minimum, maximum]] of Object.entries(layoutLimits)) {
        if (typeof input[key] === 'number' && Number.isFinite(input[key])) {
            result[key] = Math.round(Math.max(minimum, Math.min(maximum, input[key])));
        }
    }
    return result;
}

export function fitLayout(input, width, height) {
    const saved = cleanLayout(input);
    const sidebarDefault = width <= 1100 ? 180 : width <= 1400 ? 185 : 208;
    const inspectorDefault = width <= 1100 ? 230 : width <= 1400 ? 250 : 270;
    const sidebarWidth = Math.min(saved.sidebarWidth ?? sidebarDefault, Math.max(160, width - 570));
    return {
        sidebarWidth,
        inspectorWidth: Math.min(saved.inspectorWidth ?? inspectorDefault, Math.max(200, width - sidebarWidth - 370)),
        worktreesHeight: Math.min(saved.worktreesHeight ?? 246, Math.max(84, height - 170)),
    };
}
