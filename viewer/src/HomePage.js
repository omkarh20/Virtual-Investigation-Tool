/**
 * HomePage.js
 *
 * Handles the Home / Dashboard page logic:
 *   - "New Investigation" button → upload modal with 3 input modes
 *   - Uploads to backend and navigates to the Pipeline page
 *   - "Skip to Renderer" shortcut
 *   - "Previous Investigations" placeholder (wired to GET /jobs but no DB yet)
 */

import { router } from './router.js';

const BACKEND = 'http://localhost:8000';

export function initHomePage() {
    // ── Element refs ─────────────────────────────────────────────────────────
    const newBtn        = document.getElementById('home-new-btn');
    const skipBtn       = document.getElementById('home-skip-btn');
    const modal         = document.getElementById('home-modal');
    const modalClose    = document.getElementById('home-modal-close');
    const modeVideo     = document.getElementById('upload-mode-video');
    const modeZip       = document.getElementById('upload-mode-zip');
    const modeDir       = document.getElementById('upload-mode-dir');
    const inputVideo    = document.getElementById('input-video');
    const inputZip      = document.getElementById('input-zip');
    const inputDir      = document.getElementById('input-dir');
    const projectName   = document.getElementById('project-name');
    const startBtn      = document.getElementById('home-start-btn');
    const uploadStatus  = document.getElementById('upload-status');
    const refreshBtn    = document.getElementById('home-refresh-btn');
    const projectsList  = document.getElementById('home-projects-list');

    let selectedFile = null;
    let selectedMode = null;

    // ── Modal open/close ─────────────────────────────────────────────────────
    if (newBtn)     newBtn.addEventListener('click',  () => openModal());
    if (modalClose) modalClose.addEventListener('click', () => closeModal());
    if (modal)      modal.addEventListener('click', (e) => { if (e.target === modal) closeModal(); });

    function openModal() {
        if (modal) modal.style.display = 'flex';
        resetModal();
    }
    function closeModal() {
        if (modal) modal.style.display = 'none';
    }
    function resetModal() {
        selectedFile = null;
        selectedMode = null;
        if (inputVideo) inputVideo.value = '';
        if (inputZip)   inputZip.value = '';
        if (inputDir)   inputDir.value = '';
        if (uploadStatus) uploadStatus.textContent = '';
        if (startBtn) startBtn.disabled = true;
    }

    // ── Upload mode switching ────────────────────────────────────────────────
    function setActiveMode(mode) {
        selectedMode = mode;
        [modeVideo, modeZip, modeDir].forEach(b => b && b.classList.remove('active-mode'));
        document.querySelectorAll('.upload-input-group').forEach(g => g.style.display = 'none');

        if (mode === 'video') {
            if (modeVideo) modeVideo.classList.add('active-mode');
            const g = document.getElementById('group-video');
            if (g) g.style.display = 'block';
        } else if (mode === 'zip') {
            if (modeZip) modeZip.classList.add('active-mode');
            const g = document.getElementById('group-zip');
            if (g) g.style.display = 'block';
        } else if (mode === 'dir') {
            if (modeDir) modeDir.classList.add('active-mode');
            const g = document.getElementById('group-dir');
            if (g) g.style.display = 'block';
        }

        selectedFile = null;
        if (startBtn) startBtn.disabled = true;
    }

    if (modeVideo) modeVideo.addEventListener('click', () => setActiveMode('video'));
    if (modeZip)   modeZip.addEventListener('click',   () => setActiveMode('zip'));
    if (modeDir)   modeDir.addEventListener('click',   () => setActiveMode('dir'));

    // ── File selection ───────────────────────────────────────────────────────
    if (inputVideo) {
        inputVideo.addEventListener('change', () => {
            selectedFile = inputVideo.files[0] || null;
            if (startBtn) startBtn.disabled = !selectedFile;
        });
    }

    if (inputZip) {
        inputZip.addEventListener('change', () => {
            selectedFile = inputZip.files[0] || null;
            if (startBtn) startBtn.disabled = !selectedFile;
        });
    }

    if (inputDir) {
        inputDir.addEventListener('change', () => {
            // For directory uploads we bundle all files as a zip client-side
            selectedFile = inputDir.files.length > 0 ? inputDir.files : null;
            if (startBtn) startBtn.disabled = !selectedFile;
        });
    }

    // ── Start pipeline ───────────────────────────────────────────────────────
    if (startBtn) {
        startBtn.addEventListener('click', async () => {
            if (!selectedFile && !selectedMode) return;
            await startPipeline();
        });
    }

    async function startPipeline() {
        if (uploadStatus) uploadStatus.textContent = 'Uploading...';
        if (startBtn) startBtn.disabled = true;

        try {
            let fileToUpload;
            let filename;

            if (selectedMode === 'dir') {
                // Bundle directory files into a zip
                const { default: JSZip } = await import('jszip');
                const zip = new JSZip();
                const files = Array.from(selectedFile);
                for (const f of files) {
                    // Use just the filename (not full path) inside the zip
                    zip.file(f.name, f);
                }
                const zipBlob = await zip.generateAsync({ type: 'blob' });
                filename = (projectName?.value.trim() || 'project') + '_images.zip';
                fileToUpload = new File([zipBlob], filename, { type: 'application/zip' });
            } else {
                fileToUpload = selectedFile;
                filename = fileToUpload.name;
            }

            // POST /upload
            const formData = new FormData();
            formData.append('file', fileToUpload, filename);
            const uploadRes = await fetch(`${BACKEND}/upload`, { method: 'POST', body: formData });
            if (!uploadRes.ok) throw new Error(`Upload failed: ${uploadRes.status}`);
            const { job_id } = await uploadRes.json();

            if (uploadStatus) uploadStatus.textContent = 'Starting pipeline...';

            // POST /run-pipeline
            const pipelineRes = await fetch(`${BACKEND}/run-pipeline`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ job_id, config: {} }),
            });
            if (!pipelineRes.ok) throw new Error(`Pipeline start failed: ${pipelineRes.status}`);

            closeModal();
            router.goPipeline(job_id);
        } catch (err) {
            if (uploadStatus) uploadStatus.textContent = `Error: ${err.message}`;
            if (startBtn) startBtn.disabled = false;
        }
    }

    // ── Skip to renderer ─────────────────────────────────────────────────────
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
