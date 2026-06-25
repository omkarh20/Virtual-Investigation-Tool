/**
 * HomePage.js
 *
 * Handles the Home / Dashboard page logic:
 *   - "New Investigation" button → Navigates to pipeline with 'new' job_id
 *   - "Skip to Renderer" shortcut
 *   - "Previous Investigations" placeholder (wired to GET /jobs but no DB yet)
 */

import { router } from './router.js';

const BACKEND = `http://${window.location.hostname}:8000`;

export function initHomePage() {
    // ── Element refs ─────────────────────────────────────────────────────────
    const newBtn        = document.getElementById('home-new-btn');
    const skipBtn       = document.getElementById('home-skip-btn');
    const refreshBtn    = document.getElementById('home-refresh-btn');
    const projectsList  = document.getElementById('home-projects-list');

    if (newBtn) {
        newBtn.addEventListener('click', () => {
            router.goPipeline('new');
        });
    }

    if (skipBtn) {
        skipBtn.addEventListener('click', () => router.goRenderer());
    }

    // ── Previous Investigations (placeholder) ─────────────────────────────────
    if (refreshBtn) {
        refreshBtn.addEventListener('click', () => loadProjects());
    }

    async function loadProjects() {
        if (!projectsList) return;
        projectsList.innerHTML = '<p class="projects-empty">Loading...</p>';
        try {
            const res = await fetch(`${BACKEND}/jobs`);
            const jobs = await res.json();
            if (!jobs.length) {
                projectsList.innerHTML = '<p class="projects-empty">No saved projects yet.</p>';
                return;
            }
            projectsList.innerHTML = '';
            jobs.forEach(job => {
                const card = document.createElement('div');
                card.className = 'project-card';
                card.innerHTML = `
                    <span class="project-name">${job.filename || job.job_id}</span>
                    <span class="project-status status-${job.status}">${job.status}</span>
                `;
                card.addEventListener('click', () => {
                    if (job.status === 'done') {
                        router.goRenderer();
                    } else {
                        router.goPipeline(job.job_id);
                    }
                });
                projectsList.appendChild(card);
            });
        } catch {
            projectsList.innerHTML = '<p class="projects-empty">Could not load projects (is the backend running?).</p>';
        }
    }

    // Load projects whenever we land on the home page
    window.addEventListener('route:home', () => loadProjects());
    // Also load on init
    loadProjects();
}
