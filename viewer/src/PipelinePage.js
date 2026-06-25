/**
 * PipelinePage.js
 *
 * Handles the Pipeline Progress page:
 *   - Configures the pipeline options (Full vs Advanced modes)
 *   - Connects to the WebSocket for the current job
 *   - Updates per-step progress bars and a log area
 *   - Handles pausing between phases and "Continue" actions
 *   - Fetches intermediate results and builds Download buttons
 *   - Enables the "View in Renderer" button when the pipeline is done
 */

import { router } from './router.js';

const BACKEND_URL = `http://${window.location.hostname}:8000`;
const BACKEND_WS  = `ws://${window.location.hostname}:8000`;

const STEPS = [
    { id: 1, label: 'Preparing Images' },
    { id: 2, label: 'COLMAP Sparse' },
    { id: 3, label: 'COLMAP Dense', optional: true },
    { id: 4, label: '3DGS Training' },
    { id: 5, label: 'Segmentation' },
];

export function initPipelinePage() {
    let ws = null;
    let currentJobId = null;
    let isAdvancedMode = false;

    // ── Element refs ──────────────────────────────────────────────────────────
    const jobTitle        = document.getElementById('pipeline-job-title');
    const logEl           = document.getElementById('pipeline-log');
    const viewBtn         = document.getElementById('pipeline-view-btn');
    const homeBtn         = document.getElementById('pipeline-home-btn');
    
    const configPanel     = document.getElementById('pipeline-config');
    const stepsContainer  = document.getElementById('pipeline-steps-container');
    const phaseControl    = document.getElementById('phase-control');
    const phaseSummary    = document.getElementById('phase-summary');
    const nextPhaseLabel  = document.getElementById('next-phase-label');
    
    // Modes & Advanced
    const modeFullBtn     = document.getElementById('mode-full-btn');
    const modeAdvBtn      = document.getElementById('mode-advanced-btn');
    const advancedConfig  = document.getElementById('advanced-config-section');
    const cfgStartPhase   = document.getElementById('cfg-start-phase');
    const inputHelper     = document.getElementById('input-helper-text');
    
    // Results Panel
    const resultsPanel    = document.getElementById('results-panel');
    const resultsList     = document.getElementById('results-list');

    // Buttons
    const runBtn          = document.getElementById('pipeline-run-btn');
    const runAllBtn       = document.getElementById('pipeline-run-all-btn');
    const runSingleBtn    = document.getElementById('pipeline-run-single-btn');
    const continueBtn     = document.getElementById('phase-continue-btn');
    const runRemainingBtn = document.getElementById('phase-run-remaining-btn');

    // Config sections
    const cfgPrep         = document.getElementById('cfg-section-prep');
    const cfgColmap       = document.getElementById('cfg-section-colmap');
    const cfg3dgs         = document.getElementById('cfg-section-3dgs');

    // Config inputs
    const cfgDense        = document.getElementById('cfg-dense');
    const stepRow3        = document.getElementById('step-row-3');
    const cfgFrameRate    = document.getElementById('cfg-frame-rate');

    // Upload inputs
    const modeVideo       = document.getElementById('upload-mode-video');
    const modeZip         = document.getElementById('upload-mode-zip');
    const modeDir         = document.getElementById('upload-mode-dir');
    const inputVideo      = document.getElementById('input-video');
    const inputZip        = document.getElementById('input-zip');
    const inputDir        = document.getElementById('input-dir');
    const projectName     = document.getElementById('project-name');
    const uploadStatus    = document.getElementById('upload-status');
    const uploadSection   = document.getElementById('upload-section');

    let selectedFile = null;
    let selectedMode = 'video';
    let completedPhases = [];

    // ── UI Modes (Full vs Advanced) ───────────────────────────────────────────
    if (modeFullBtn && modeAdvBtn) {
        modeFullBtn.addEventListener('click', () => setUIMode(false));
        modeAdvBtn.addEventListener('click', () => setUIMode(true));
    }

    function setUIMode(advanced) {
        isAdvancedMode = advanced;
        if (advanced) {
            modeAdvBtn.classList.add('active-mode');
            modeAdvBtn.style.background = '#6366f1';
            modeAdvBtn.style.color = '#fff';
            modeFullBtn.classList.remove('active-mode');
            modeFullBtn.style.background = 'transparent';
            modeFullBtn.style.color = '#9ca3af';
            
            advancedConfig.style.display = 'block';
            runBtn.style.display = 'none';
            runAllBtn.style.display = 'none';
            runSingleBtn.style.display = 'inline-block';
            updateUploadHelperForPhase();
        } else {
            modeFullBtn.classList.add('active-mode');
            modeFullBtn.style.background = '#6366f1';
            modeFullBtn.style.color = '#fff';
            modeAdvBtn.classList.remove('active-mode');
            modeAdvBtn.style.background = 'transparent';
            modeAdvBtn.style.color = '#9ca3af';

            advancedConfig.style.display = 'none';
            cfgStartPhase.value = "1";
            runBtn.style.display = 'inline-block';
            runAllBtn.style.display = 'inline-block';
            runSingleBtn.style.display = 'none';
            updateUploadHelperForPhase();
        }
    }

    if (cfgStartPhase) {
        cfgStartPhase.addEventListener('change', updateUploadHelperForPhase);
    }

    function updateUploadHelperForPhase() {
        const phase = parseInt(cfgStartPhase?.value || "1");
        if (phase === 4) {
            inputHelper.textContent = "(ZIP of COLMAP 'images' & 'sparse', or select natively)";
            modeVideo.style.display = 'none';
            setActiveMode('zip');
        } else {
            inputHelper.textContent = "(Video or Images)";
            modeVideo.style.display = 'inline-block';
            if (selectedMode === 'video' || modeVideo.style.display === 'none') {
                setActiveMode('video');
            }
        }

        if (isAdvancedMode) {
            if (cfgPrep) cfgPrep.style.display = (phase === 1) ? 'block' : 'none';
            if (cfgColmap) cfgColmap.style.display = (phase === 2) ? 'block' : 'none';
            if (cfg3dgs) cfg3dgs.style.display = (phase === 4) ? 'block' : 'none';
        } else {
            if (cfgPrep) cfgPrep.style.display = 'block';
            if (cfgColmap) cfgColmap.style.display = 'block';
            if (cfg3dgs) cfg3dgs.style.display = 'block';
        }
    }

    // ── Setup Upload logic ─────────────────────────────────────────────────────
    function setActiveMode(mode) {
        selectedMode = mode;
        [modeVideo, modeZip, modeDir].forEach(b => b && b.classList.remove('active-mode'));
        document.querySelectorAll('.upload-input-group').forEach(g => g.style.display = 'none');

        if (mode === 'video') {
            if (modeVideo) modeVideo.classList.add('active-mode');
            const g = document.getElementById('group-video');
            if (g) g.style.display = 'block';
            if (cfgFrameRate) cfgFrameRate.disabled = false; // Enable FPS
        } else if (mode === 'zip') {
            if (modeZip) modeZip.classList.add('active-mode');
            const g = document.getElementById('group-zip');
            if (g) g.style.display = 'block';
            if (cfgFrameRate) cfgFrameRate.disabled = true; // Disable FPS
        } else if (mode === 'dir') {
            if (modeDir) modeDir.classList.add('active-mode');
            const g = document.getElementById('group-dir');
            if (g) g.style.display = 'block';
            if (cfgFrameRate) cfgFrameRate.disabled = true; // Disable FPS
        }

        selectedFile = null;
        updateRunButtonsState();
    }

    if (modeVideo) modeVideo.addEventListener('click', () => setActiveMode('video'));
    if (modeZip)   modeZip.addEventListener('click',   () => setActiveMode('zip'));
    if (modeDir)   modeDir.addEventListener('click',   () => setActiveMode('dir'));

    function handleFileChange(files) {
        selectedFile = files;
        updateRunButtonsState();
    }

    if (inputVideo) inputVideo.addEventListener('change', () => handleFileChange(inputVideo.files[0] || null));
    if (inputZip)   inputZip.addEventListener('change', () => handleFileChange(inputZip.files[0] || null));
    if (inputDir)   inputDir.addEventListener('change', () => handleFileChange(inputDir.files.length > 0 ? inputDir.files : null));

    function updateRunButtonsState() {
        const canRun = !!selectedFile || currentJobId !== 'new';
        if (runBtn) runBtn.disabled = !canRun;
        if (runAllBtn) runAllBtn.disabled = !canRun;
        if (runSingleBtn) runSingleBtn.disabled = !canRun;
    }

    // Initialize mode
    setUIMode(false);

    if (homeBtn) homeBtn.addEventListener('click', () => {
        disconnectWS();
        router.goHome();
    });

    if (viewBtn) viewBtn.addEventListener('click', () => {
        router.goRenderer();
    });

    // Toggle Dense visibility in UI
    if (cfgDense) {
        cfgDense.addEventListener('change', () => {
            if (stepRow3) stepRow3.style.display = cfgDense.checked ? 'grid' : 'none';
        });
    }

    // ── Listen for route event ─────────────────────────────────────────────────
    window.addEventListener('route:pipeline', async (e) => {
        const { jobId } = e.detail;
        if (jobId === currentJobId) return; 
        currentJobId = jobId;
        completedPhases = [];
        renderResultsPanel();
        
        if (jobTitle) {
            jobTitle.textContent = jobId === 'new' ? 'New Pipeline' : `Job: ${jobId.slice(0, 8)}…`;
        }

        if (jobId === 'new') {
            if (uploadSection) uploadSection.style.display = 'block';
            if (uploadStatus) uploadStatus.textContent = '';
            selectedFile = null;
            if (inputVideo) inputVideo.value = '';
            if (inputZip) inputZip.value = '';
            if (inputDir) inputDir.value = '';
            updateRunButtonsState();
            showConfig();
            return;
        }
        
        if (uploadSection) uploadSection.style.display = 'none'; 
        try {
            const res = await fetch(`${BACKEND_URL}/jobs/${jobId}`);
            if (!res.ok) throw new Error("Job not found");
            const job = await res.json();
            
            completedPhases = job.completed_phases || [];
            renderResultsPanel();

            if (job.status === "uploaded") {
                showConfig();
            } else {
                showProgress();
                startWatching(jobId);
                if (job.status === "paused") {
                    phaseControl.style.display = 'flex';
                }
            }
        } catch (e) {
            console.error(e);
            router.goHome();
        }
    });

    // ── UI States ─────────────────────────────────────────────────────────────
    function showConfig() {
        if (configPanel) configPanel.style.display = 'block';
        if (stepsContainer) stepsContainer.style.display = 'none';
        if (phaseControl) phaseControl.style.display = 'none';
        if (viewBtn) viewBtn.disabled = true;
    }

    function showProgress() {
        if (configPanel) configPanel.style.display = 'none';
        if (stepsContainer) stepsContainer.style.display = 'block';
        if (phaseControl) phaseControl.style.display = 'none';
        if (viewBtn) viewBtn.disabled = true;
    }

    // ── Action Handlers ────────────────────────────────────────────────────────
    function getConfigData() {
        return {
            frame_rate: document.getElementById('cfg-frame-rate')?.value || "2",
            colmap_matcher: document.getElementById('cfg-matcher')?.value || "exhaustive",
            colmap_camera_model: document.getElementById('cfg-camera-model')?.value || "OPENCV",
            colmap_quality: document.getElementById('cfg-quality')?.value || "medium",
            colmap_use_gpu: document.getElementById('cfg-gpu')?.checked ?? true,
            colmap_dense_enable: document.getElementById('cfg-dense')?.checked ?? false,
            gs_iterations: parseInt(document.getElementById('cfg-gs-iterations')?.value || "30000", 10),
            gs_max_resolution: parseInt(document.getElementById('cfg-gs-resolution')?.value || "0", 10),
        };
    }

    async function performUpload() {
        if (!selectedFile) throw new Error("No file selected");
        if (uploadStatus) uploadStatus.textContent = 'Uploading...';

        let fileToUpload;
        let filename;

        if (selectedMode === 'dir') {
            const { default: JSZip } = await import('jszip');
            const zip = new JSZip();
            const files = Array.from(selectedFile);
            for (const f of files) {
                // If the user selects a folder, file.webkitRelativePath contains the path
                const path = f.webkitRelativePath || f.name;
                // remove top level folder name if we want, but better to keep it and let backend flatten, 
                // actually JSZip doesn't auto flatten. The user wants native folder select.
                zip.file(path, f);
            }
            const zipBlob = await zip.generateAsync({ type: 'blob' });
            filename = (projectName?.value.trim() || 'project') + '_images.zip';
            fileToUpload = new File([zipBlob], filename, { type: 'application/zip' });
        } else {
            fileToUpload = selectedFile;
            filename = fileToUpload.name;
        }

        const formData = new FormData();
        formData.append('file', fileToUpload, filename);
        const uploadRes = await fetch(`${BACKEND_URL}/upload`, { method: 'POST', body: formData });
        if (!uploadRes.ok) throw new Error(`Upload failed: ${uploadRes.status}`);
        const { job_id } = await uploadRes.json();
        
        if (uploadStatus) uploadStatus.textContent = 'Upload complete. Starting...';
        return job_id;
    }

    async function submitRun(mode, isSinglePhase = false) {
        if (runBtn) runBtn.disabled = true;
        if (runAllBtn) runAllBtn.disabled = true;
        if (runSingleBtn) runSingleBtn.disabled = true;
        
        const config = getConfigData();
        if (stepRow3) stepRow3.style.display = config.colmap_dense_enable ? 'grid' : 'none';

        const start_phase = parseInt(cfgStartPhase?.value || "1");
        const end_phase = isSinglePhase ? start_phase : null;

        try {
            let targetJobId = currentJobId;

            if (currentJobId === 'new') {
                targetJobId = await performUpload();
                currentJobId = targetJobId;
                if (jobTitle) jobTitle.textContent = `Job: ${targetJobId.slice(0, 8)}…`;
            }

            const res = await fetch(`${BACKEND_URL}/run-pipeline`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ job_id: targetJobId, config, mode, start_phase, end_phase }),
            });
            if (!res.ok) throw new Error("Failed to start pipeline");
            
            showProgress();
            resetSteps();
            startWatching(targetJobId);

            window.history.replaceState(null, '', `#/pipeline/${targetJobId}`);

        } catch (e) {
            alert(e.message);
            if (uploadStatus) uploadStatus.textContent = `Error: ${e.message}`;
            updateRunButtonsState();
        }
    }

    async function submitContinue(mode) {
        if (!currentJobId) return;
        if (phaseControl) phaseControl.style.display = 'none';
        try {
            const res = await fetch(`${BACKEND_URL}/continue-pipeline`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ job_id: currentJobId, mode }),
            });
            if (!res.ok) throw new Error("Failed to continue pipeline");
        } catch (e) {
            alert(e.message);
        }
    }

    if (runBtn) runBtn.addEventListener('click', () => submitRun('step'));
    if (runAllBtn) runAllBtn.addEventListener('click', () => submitRun('all'));
    if (runSingleBtn) runSingleBtn.addEventListener('click', () => submitRun('step', true));
    if (continueBtn) continueBtn.addEventListener('click', () => submitContinue('step'));
    if (runRemainingBtn) runRemainingBtn.addEventListener('click', () => submitContinue('all'));

    // ── WebSocket connection ───────────────────────────────────────────────────
    function startWatching(jobId) {
        disconnectWS();
        
        if (logEl) logEl.textContent = '';
        
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
            if (phaseControl) phaseControl.style.display = 'none';
        } else if (msg.type === 'log') {
            updateStepProgress(msg.step, msg.progress);
            appendLog(msg.text);
        } else if (msg.type === 'phase_complete') {
            markStep(msg.phase, 'done', 100);
            appendLog(`✓ ${msg.label} complete.`);
            if (phaseSummary) phaseSummary.innerHTML = `<strong>${msg.label} finished.</strong>`;
            if (!completedPhases.includes(msg.phase)) {
                completedPhases.push(msg.phase);
            }
            renderResultsPanel();
        } else if (msg.type === 'phase_paused') {
            if (msg.next_phase === null) {
                // Stopped after a single phase via Advanced Mode end_phase
                appendLog('✓ Single phase execution complete.');
                if (phaseControl) phaseControl.style.display = 'none';
                
                // Show a nice "continue manually" option if they want to jump back to full pipeline
                if (nextPhaseLabel) nextPhaseLabel.textContent = 'Configuration';
            } else {
                if (nextPhaseLabel) nextPhaseLabel.textContent = msg.next_label || 'Next Phase';
                if (phaseControl) phaseControl.style.display = 'flex';
            }
        } else if (msg.type === 'done') {
            markAllDone();
            appendLog('✓ Pipeline complete.');
            if (viewBtn) viewBtn.disabled = false;
            if (phaseControl) phaseControl.style.display = 'none';
        }
    }

    function renderResultsPanel() {
        if (!resultsPanel || !resultsList) return;
        if (completedPhases.length === 0) {
            resultsPanel.style.display = 'none';
            return;
        }
        resultsPanel.style.display = 'block';
        resultsList.innerHTML = '';
        
        // Exclude dummy segmentation phase 5 for downloads
        const downloadable = completedPhases.filter(p => p < 5).sort();
        
        downloadable.forEach(pid => {
            const step = STEPS.find(s => s.id === pid);
            const label = step ? step.label : `Phase ${pid}`;
            const btn = document.createElement('a');
            btn.href = `${BACKEND_URL}/download/${currentJobId}/${pid}`;
            btn.target = '_blank';
            btn.className = 'btn btn-secondary';
            btn.innerHTML = `⬇ Download ${label}`;
            btn.style.background = 'rgba(255,255,255,0.1)';
            btn.style.border = '1px solid rgba(255,255,255,0.2)';
            btn.style.color = 'white';
            resultsList.appendChild(btn);
        });
    }

    // ── Step UI helpers ────────────────────────────────────────────────────────
    function resetSteps() {
        STEPS.forEach(s => {
            const row = document.getElementById(`step-row-${s.id}`);
            if (!row) return;
            row.className = s.optional ? 'step-row step-optional' : 'step-row';
            const bar = row.querySelector('.step-bar-fill');
            const status = row.querySelector('.step-status');
            if (bar) bar.style.width = '0%';
            if (status) status.textContent = s.optional ? 'Skipped' : 'Pending';
        });
    }

    function markStep(stepNum, state, pct) {
        for (let i = 1; i < stepNum; i++) {
            const prev = document.getElementById(`step-row-${i}`);
            // If the step is displayed and not done, mark it done.
            if (prev && prev.style.display !== 'none' && !prev.classList.contains('done')) {
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

    function updateStepProgress(stepNum, pct) {
        const row = document.getElementById(`step-row-${stepNum}`);
        if (!row) return;
        const bar = row.querySelector('.step-bar-fill');
        if (bar) bar.style.width = `${Math.max(0, pct)}%`;
    }

    function markAllDone() {
        STEPS.forEach(s => {
            const row = document.getElementById(`step-row-${s.id}`);
            if (!row || row.style.display === 'none') return;
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
