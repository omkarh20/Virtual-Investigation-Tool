/**
 * PipelinePage.js
 *
 * Handles the Pipeline Progress page:
 *   - Connects to the WebSocket for the current job
 *   - Updates per-step progress bars and a log area
 *   - Enables the "View in Renderer" button when the pipeline is done
 */

import { router } from './router.js';

const BACKEND_WS  = 'ws://localhost:8000';

const STEPS = [
    { id: 1, label: 'Preparing Images' },
    { id: 2, label: 'COLMAP SfM' },
    { id: 3, label: '3DGS Training' },
    { id: 4, label: 'Segmentation' },
];

export function initPipelinePage() {
    let ws = null;
    let currentJobId = null;

    // ── Element refs ──────────────────────────────────────────────────────────
    const jobTitle    = document.getElementById('pipeline-job-title');
    const logEl       = document.getElementById('pipeline-log');
    const viewBtn     = document.getElementById('pipeline-view-btn');
    const homeBtn     = document.getElementById('pipeline-home-btn');

    if (homeBtn) homeBtn.addEventListener('click', () => {
        disconnectWS();
        router.goHome();
    });

    if (viewBtn) viewBtn.addEventListener('click', () => {
        router.goRenderer();
    });

    // ── Listen for route event ─────────────────────────────────────────────────
    window.addEventListener('route:pipeline', (e) => {
        const { jobId } = e.detail;
        if (jobId === currentJobId) return; // already watching this job
        currentJobId = jobId;
        startWatching(jobId);
    });

    // ── WebSocket connection ───────────────────────────────────────────────────
    function startWatching(jobId) {
        disconnectWS();

        // Reset UI
        if (jobTitle) jobTitle.textContent = `Job: ${jobId.slice(0, 8)}…`;
        if (logEl)    logEl.textContent = '';
        if (viewBtn)  viewBtn.disabled = true;

        resetSteps();

        ws = new WebSocket(`${BACKEND_WS}/progress/${jobId}`);

        ws.onmessage = (event) => {
            const msg = JSON.parse(event.data);
            handleMessage(msg);
        };

        ws.onerror = () => appendLog('[WebSocket error — is the backend running?]');
        ws.onclose = () => appendLog('[Connection closed]');
    }

    function disconnectWS() {
        if (ws) { try { ws.close(); } catch(_) {} ws = null; }
    }

    // ── Message handling ───────────────────────────────────────────────────────
    function handleMessage(msg) {
        if (msg.type === 'step_start') {
            markStep(msg.step, 'active', 0);
            appendLog(`▶ ${msg.label}`);
        } else if (msg.type === 'log') {
            updateStepProgress(msg.step, msg.progress);
            appendLog(msg.text);
        } else if (msg.type === 'done') {
            markAllDone();
            appendLog('✓ Pipeline complete.');
            if (viewBtn) viewBtn.disabled = false;
        }
    }

    // ── Step UI helpers ────────────────────────────────────────────────────────
    function resetSteps() {
        STEPS.forEach(s => {
            const row = document.getElementById(`step-row-${s.id}`);
            if (!row) return;
            row.className = 'step-row';
            const bar = row.querySelector('.step-bar-fill');
            const status = row.querySelector('.step-status');
            if (bar) bar.style.width = '0%';
            if (status) status.textContent = 'Pending';
        });
    }

    function markStep(stepNum, state, pct) {
        // Mark previous steps done
        for (let i = 1; i < stepNum; i++) {
            const prev = document.getElementById(`step-row-${i}`);
            if (prev && !prev.classList.contains('done')) {
                prev.className = 'step-row done';
                const bar = prev.querySelector('.step-bar-fill');
                const status = prev.querySelector('.step-status');
                if (bar) bar.style.width = '100%';
                if (status) status.textContent = 'Done';
            }
        }

        const row = document.getElementById(`step-row-${stepNum}`);
        if (!row) return;
        row.className = `step-row ${state}`;
        const bar = row.querySelector('.step-bar-fill');
        const status = row.querySelector('.step-status');
        if (bar) bar.style.width = `${pct}%`;
        if (status) status.textContent = state === 'active' ? 'Running…' : 'Done';
    }

    function updateStepProgress(stepNum, overallPct) {
        const row = document.getElementById(`step-row-${stepNum}`);
        if (!row) return;
        // Convert overall % to per-step %: each step is 25% of total
        const stepsTotal = STEPS.length;
        const stepWidth = 100 / stepsTotal;
        const stepBase  = (stepNum - 1) * stepWidth;
        const withinStep = Math.min(100, ((overallPct - stepBase) / stepWidth) * 100);
        const bar = row.querySelector('.step-bar-fill');
        if (bar) bar.style.width = `${Math.max(0, withinStep)}%`;
    }

    function markAllDone() {
        STEPS.forEach(s => {
            const row = document.getElementById(`step-row-${s.id}`);
            if (!row) return;
            row.className = 'step-row done';
            const bar = row.querySelector('.step-bar-fill');
            const status = row.querySelector('.step-status');
            if (bar) bar.style.width = '100%';
            if (status) status.textContent = 'Done';
        });
    }

    function appendLog(text) {
        if (!logEl) return;
        logEl.textContent += text + '\n';
        logEl.scrollTop = logEl.scrollHeight;
    }
}
