/**
 * HomePage.js
 *
 * Handles the Home / Dashboard page logic:
 *   - "New Investigation" button → Navigates to pipeline with 'new' job_id
 *   - "Skip to Renderer" shortcut
 *   - "Previous Investigations" placeholder (wired to GET /jobs but no DB yet)
 */

import { router } from './router.js';

const host = window.location.hostname === 'localhost' ? '127.0.0.1' : window.location.hostname;
const BACKEND = `http://${host}:8000`;

export function initHomePage() {
    // ── Element refs ─────────────────────────────────────────────────────────
    const newBtn        = document.getElementById('home-new-btn');
    const skipBtn       = document.getElementById('home-skip-btn');
    const refreshBtn    = document.getElementById('home-refresh-btn');
    const projectsList  = document.getElementById('home-projects-list');

    const inputPly      = document.getElementById('home-input-ply');
    const uploadStatus  = document.getElementById('home-upload-status');

    if (newBtn) {
        newBtn.addEventListener('click', () => {
            router.goPipeline('new');
        });
    }

    if (skipBtn) {
        skipBtn.addEventListener('click', () => router.goRenderer());
    }

    if (inputPly) {
        inputPly.addEventListener('change', async (e) => {
            const file = e.target.files[0];
            if (!file) return;
            if (!file.name.endsWith('.ply')) {
                alert('Only .ply files are supported!');
                return;
            }

            if (uploadStatus) {
                uploadStatus.innerText = `Uploading ${file.name}...`;
                uploadStatus.style.color = '#cbd5e1';
            }

            const formData = new FormData();
            formData.append('file', file);

            try {
                const res = await fetch(`${BACKEND}/mesh-ply`, {
                    method: 'POST',
                    body: formData
                });
                if (!res.ok) {
                    throw new Error('Upload failed');
                }
                const data = await res.json();
                if (data.job_id) {
                    if (uploadStatus) uploadStatus.innerText = '';
                    router.goPipeline(data.job_id);
                } else {
                    throw new Error('No job ID returned');
                }
            } catch (err) {
                console.error(err);
                if (uploadStatus) {
                    uploadStatus.innerText = `Upload failed: ${err.message}`;
                    uploadStatus.style.color = '#f87171';
                }
            }
        });
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
                card.style.display = 'flex';
                card.style.alignItems = 'center';
                card.innerHTML = `
                    <span class="project-name">${job.project_name || job.filename || job.job_id}</span>
                    <span class="project-status status-${job.status}" style="margin-left: 10px;">${job.status}</span>
                    <button class="delete-job-btn" style="margin-left:auto; background:none; border:none; color:#ef4444; cursor:pointer; padding: 4px;" title="Delete Project">
                        <svg width="16" height="16" fill="currentColor" viewBox="0 0 16 16"><path d="M5.5 5.5A.5.5 0 0 1 6 6v6a.5.5 0 0 1-1 0V6a.5.5 0 0 1 .5-.5zm2.5 0a.5.5 0 0 1 .5.5v6a.5.5 0 0 1-1 0V6a.5.5 0 0 1 .5-.5zm3 .5a.5.5 0 0 0-1 0v6a.5.5 0 0 0 1 0V6z"/><path fill-rule="evenodd" d="M14.5 3a1 1 0 0 1-1 1H13v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V4h-.5a1 1 0 0 1-1-1V2a1 1 0 0 1 1-1H6a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1h3.5a1 1 0 0 1 1 1v1zM4.118 4 4 4.059V13a1 1 0 0 0 1 1h6a1 1 0 0 0 1-1V4.059L11.882 4H4.118zM2.5 3V2h11v1h-11z"/></svg>
                    </button>
                `;
                
                const delBtn = card.querySelector('.delete-job-btn');
                delBtn.addEventListener('click', async (e) => {
                    e.stopPropagation();
                    if (!confirm(`Are you sure you want to delete ${job.filename || job.job_id}? This cannot be undone.`)) return;
                    try {
                        const res = await fetch(`${BACKEND}/jobs/${job.job_id}`, { method: 'DELETE' });
                        if (res.ok) {
                            loadProjects();
                        }
                    } catch (err) {
                        console.error('Failed to delete', err);
                    }
                });

                card.addEventListener('click', () => {
                    router.goPipeline(job.job_id);
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
