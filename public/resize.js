import { cleanLayout, fitLayout, layoutLimits } from '/layout.mjs';

export async function initializeResizing() {
    const desktop = window.branchlightDesktop;
    let preferences = {};
    try {
        preferences = cleanLayout(desktop ? await desktop.loadLayout() : JSON.parse(localStorage.getItem('branchlight-layout') || '{}'));
    } catch {}
    const sidebar = document.querySelector('.sidebar');
    const handles = [...document.querySelectorAll('[data-split]')];
    const properties = { sidebarWidth: '--sidebar-width', inspectorWidth: '--inspector-width', worktreesHeight: '--worktrees-height' };
    let sizes;
    let drag;
    const fit = values => fitLayout(values, document.body.clientWidth, sidebar.clientHeight);
    const apply = () => {
        sizes = fit(preferences);
        for (const [key, property] of Object.entries(properties)) {
            document.body.style.setProperty(property, `${sizes[key]}px`);
        }
        for (const handle of handles) {
            const key = handle.dataset.split;
            handle.setAttribute('aria-valuenow', sizes[key]);
            handle.setAttribute('aria-valuemin', layoutLimits[key][0]);
            handle.setAttribute('aria-valuemax', fit({ ...preferences, [key]: layoutLimits[key][1] })[key]);
            handle.setAttribute('aria-valuetext', `${sizes[key]} pixels`);
        }
    };
    const save = () => {
        if (desktop) {
            desktop.saveLayout(preferences).catch(console.error);
        } else {
            try {
                localStorage.setItem('branchlight-layout', JSON.stringify(preferences));
            } catch {}
        }
    };
    const update = (key, value) => {
        preferences[key] = fit({ ...preferences, [key]: value })[key];
        apply();
    };
    const finish = cancel => {
        if (!drag) {
            return;
        }
        const previous = drag;
        drag = null;
        if (cancel) {
            preferences = previous.preferences;
            apply();
        } else {
            save();
        }
        document.body.classList.remove('resizing-columns', 'resizing-rows');
        if (previous.handle.hasPointerCapture(previous.pointerId)) {
            previous.handle.releasePointerCapture(previous.pointerId);
        }
    };
    for (const handle of handles) {
        const key = handle.dataset.split;
        const horizontal = key === 'worktreesHeight';
        const direction = key === 'sidebarWidth' ? 1 : -1;
        handle.addEventListener('pointerdown', event => {
            if (event.button !== 0 || !event.isPrimary) {
                return;
            }
            event.preventDefault();
            handle.focus();
            drag = {
                handle, pointerId: event.pointerId, key, direction, horizontal,
                start: horizontal ? event.clientY : event.clientX,
                size: sizes[key], preferences: { ...preferences },
            };
            handle.setPointerCapture(event.pointerId);
            document.body.classList.add(horizontal ? 'resizing-rows' : 'resizing-columns');
        });
        handle.addEventListener('pointermove', event => {
            if (drag?.handle === handle && event.pointerId === drag.pointerId) {
                const coordinate = horizontal ? event.clientY : event.clientX;
                update(key, drag.size + direction * (coordinate - drag.start));
            }
        });
        handle.addEventListener('pointerup', () => finish(false));
        handle.addEventListener('pointercancel', () => finish(true));
        handle.addEventListener('lostpointercapture', () => finish(false));
        const reset = () => {
            delete preferences[key];
            apply();
            save();
        };
        handle.addEventListener('dblclick', reset);
        handle.addEventListener('keydown', event => {
            const backwards = horizontal ? 'ArrowUp' : 'ArrowLeft';
            const forwards = horizontal ? 'ArrowDown' : 'ArrowRight';
            if ([backwards, forwards, 'Home', 'End', 'Enter'].includes(event.key)) {
                event.preventDefault();
                event.stopPropagation();
                if (event.key === 'Enter') {
                    reset();
                    return;
                }
                const step = event.shiftKey ? 40 : 10;
                const value = event.key === 'Home' ? layoutLimits[key][0] : event.key === 'End' ? layoutLimits[key][1] :
                    sizes[key] + direction * (event.key === backwards ? -step : step);
                update(key, value);
                save();
            }
        });
    }
    document.addEventListener('keydown', event => {
        if (event.key === 'Escape' && drag) {
            event.preventDefault();
            finish(true);
        }
    });
    window.addEventListener('blur', () => finish(false));
    new ResizeObserver(apply).observe(sidebar);
    window.addEventListener('resize', apply);
    apply();
}
