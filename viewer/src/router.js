/**
 * router.js — Lightweight hash-based client-side router.
 *
 * Routes:
 *   #/               → Home page
 *   #/pipeline/:id   → Pipeline progress page
 *   #/renderer       → 3D Renderer (lazy-initialised on first visit)
 *
 * Backward compatibility:
 *   If the page URL has a real ?manifest= query param, we stash it in
 *   sessionStorage and redirect to #/renderer so the renderer can pick it up.
 */

const pages = {
    home:     document.getElementById('page-home'),
    pipeline: document.getElementById('page-pipeline'),
    renderer: document.getElementById('page-renderer'),
};

let rendererInitialised = false;
let initRendererFn = null;   // set by main.js via router.onRendererNeeded()

function showPage(name) {
    for (const [key, el] of Object.entries(pages)) {
        if (el) el.classList.toggle('active', key === name);
    }
}

function navigate(hash) {
    window.location.hash = hash;
}

function handleRoute() {
    const hash = window.location.hash || '#/';

    // ── Pipeline page: #/pipeline/<jobId>
    const pipelineMatch = hash.match(/^#\/pipeline\/(.+)$/);
    if (pipelineMatch) {
        const jobId = pipelineMatch[1];
        showPage('pipeline');
        window.dispatchEvent(new CustomEvent('route:pipeline', { detail: { jobId } }));
        return;
    }

    // ── Renderer page: #/renderer
    if (hash.startsWith('#/renderer')) {
        showPage('renderer');
        if (!rendererInitialised && initRendererFn) {
            rendererInitialised = true;
            initRendererFn();
        }
        return;
    }

    // ── Home page: everything else (#/ or empty)
    showPage('home');
    window.dispatchEvent(new CustomEvent('route:home'));
}

// Public API
export const router = {
    navigate,

    goHome()            { navigate('#/'); },
    goPipeline(jobId)   { navigate(`#/pipeline/${jobId}`); },
    goRenderer()        { navigate('#/renderer'); },

    /** Call this from main.js, passing the function that boots Three.js. */
    onRendererNeeded(fn) { initRendererFn = fn; },

    /** Bootstrap: handle initial URL and listen for hash changes. */
    init() {
        window.addEventListener('hashchange', handleRoute);

        // Backward-compat: real ?manifest= query param → stash and go to renderer
        const params = new URLSearchParams(window.location.search);
        const manifest = params.get('manifest');
        if (manifest) {
            sessionStorage.setItem('vit_manifest_url', manifest);
            // Clean the URL so the query string doesn't linger
            window.history.replaceState(null, '', window.location.pathname + '#/renderer');
            handleRoute();
            return;
        }

        handleRoute();   // handle whatever hash is in the URL right now
    },
};
