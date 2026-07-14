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

const host = window.location.hostname === 'localhost' ? '127.0.0.1' : window.location.hostname;
const BACKEND_URL = `http://${host}:8000`;
const BACKEND_WS  = `ws://${host}:8000`;

const STEPS = [
    { id: 1, label: 'Preparing Images' },
    { id: 2, label: 'COLMAP' },
    { id: 3, label: 'COLMAP Dense', optional: true },
    { id: 4, label: '3DGS Training' },
    { id: 5, label: 'Segmentation & Meshing' },
    { id: 6, label: 'VR Export' },
];

export function initPipelinePage() {
    let ws = null;
    let currentJobId = null;
    let isAdvancedMode = false;
    let currentLogDetails = null;
    let currentLogContent = null;

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
    const modeToggle      = document.getElementById('pipeline-mode-toggle');
    const modeFullBtn     = document.getElementById('mode-full-btn');
    const modeAdvBtn      = document.getElementById('mode-advanced-btn');
    
    const segModeAuto = document.getElementById('seg-mode-auto');
    const segModeVcam = document.getElementById('seg-mode-vcam');

    if (segModeAuto && segModeVcam) {
        segModeAuto.addEventListener('click', () => {
            segModeAuto.classList.add('active-mode');
            segModeVcam.classList.remove('active-mode');
            updateUploadHelperForPhase();
        });
        segModeVcam.addEventListener('click', () => {
            segModeVcam.classList.add('active-mode');
            segModeAuto.classList.remove('active-mode');
            updateUploadHelperForPhase();
        });
    }

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
    const cancelBtn       = document.getElementById('pipeline-cancel-btn');
    const cancelArea      = document.getElementById('pipeline-cancel-area');
    const phaseConfigPreview = document.getElementById('phase-config-preview');

    // Config sections
    const cfgPrep         = document.getElementById('cfg-section-prep');
    const cfgColmap       = document.getElementById('cfg-section-colmap');
    const cfg3dgs         = document.getElementById('cfg-section-3dgs');

    // Config inputs
    const cfgDense        = document.getElementById('cfg-dense');
    const stepRow2        = document.getElementById('step-row-2');
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
            if (cfgStartPhase) cfgStartPhase.value = "1";
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
        
        // Disable Custom Objects input if VCam mode is selected
        const segModeVcamBtn = document.getElementById('seg-mode-vcam');
        const isVcam = segModeVcamBtn && segModeVcamBtn.classList.contains('active-mode');
        const segObjectsInput = document.getElementById('cfg-seg-objects');
        if (segObjectsInput) {
            segObjectsInput.disabled = isVcam;
            segObjectsInput.style.opacity = isVcam ? '0.3' : '1.0';
            if (isVcam) {
                segObjectsInput.placeholder = "Set per-camera in Renderer";
                segObjectsInput.value = "";
            } else {
                segObjectsInput.placeholder = "e.g. knife, bottle, shoe";
            }
        }
        
        const groupZipLabel = document.querySelector('#group-zip label');
        const groupDirLabel = document.querySelector('#group-dir label');

        if (phase === 3) {
            if (inputHelper) inputHelper.textContent = "(COLMAP Workspace)";
            if (modeZip) modeZip.innerHTML = '🗜️ ZIP of COLMAP Workspace';
            if (modeDir) modeDir.innerHTML = '📁 COLMAP Workspace Folder';
            if (groupZipLabel) groupZipLabel.textContent = "Select a ZIP archive containing 'images' and 'sparse' folders";
            if (groupDirLabel) groupDirLabel.textContent = "Select a folder containing 'images' and 'sparse' folders";
            if (modeVideo) modeVideo.style.display = 'none';
            if (modeDir) modeDir.style.display = 'inline-block';
            setActiveMode('zip');
        } else if (phase === 4) {
            if (isVcam) {
                if (inputHelper) inputHelper.textContent = "(PLY File)";
                if (modeZip) modeZip.innerHTML = '📁 PLY File or ZIP';
                if (groupZipLabel) groupZipLabel.textContent = "Select a .ply file directly, or a ZIP containing 'point_cloud.ply'";
                if (modeDir) modeDir.style.display = 'none';
            } else {
                if (inputHelper) inputHelper.textContent = "(3DGS Output + Images)";
                if (modeZip) modeZip.innerHTML = '🗜️ ZIP of Segmentation Input';
                if (modeDir) modeDir.innerHTML = '📁 Segmentation Input Folder';
                if (modeDir) modeDir.style.display = 'inline-block';
                if (groupZipLabel) groupZipLabel.textContent = "Select a ZIP containing 'images/' folder, 'point_cloud.ply', and 'cameras.json'";
                if (groupDirLabel) groupDirLabel.textContent = "Select a folder containing 'images/' folder, 'point_cloud.ply', and 'cameras.json'";
            }
            if (modeVideo) modeVideo.style.display = 'none';
            setActiveMode('zip');
        } else if (phase === 5) {
            if (inputHelper) inputHelper.textContent = "(Provide a ZIP or Folder containing 'point_cloud.ply' and 'label_map.json')";
            if (modeZip) modeZip.innerHTML = '🗜️ ZIP of Segmentation Output';
            if (modeDir) modeDir.innerHTML = '📁 Segmentation Output Folder';
            if (groupZipLabel) groupZipLabel.textContent = "Select a ZIP containing 'point_cloud.ply' and 'label_map.json'";
            if (groupDirLabel) groupDirLabel.textContent = "Select a folder containing 'point_cloud.ply' and 'label_map.json'";
            if (modeVideo) modeVideo.style.display = 'none';
            if (modeDir) modeDir.style.display = 'inline-block';
            setActiveMode('zip');
        } else {
            if (inputHelper) inputHelper.textContent = "(Video or Images)";
            if (modeZip) modeZip.innerHTML = '🗜️ ZIP of Images';
            if (modeDir) modeDir.innerHTML = '📁 Image Folder';
            if (groupZipLabel) groupZipLabel.textContent = "Select a ZIP archive of images";
            if (groupDirLabel) groupDirLabel.textContent = "Select an image folder";
            if (modeVideo) modeVideo.style.display = 'inline-block';
            if (modeDir) modeDir.style.display = 'inline-block';
            if (selectedMode === 'video' || (modeVideo && modeVideo.style.display === 'none')) {
                setActiveMode('video');
            }
        }
        const cfgSeg = document.getElementById('cfg-section-seg');
        const cfgVrexport = document.getElementById('cfg-section-vrexport');
        
        if (isAdvancedMode) {
            if (cfgPrep) cfgPrep.style.display = (phase === 1) ? 'block' : 'none';
            if (cfgColmap) cfgColmap.style.display = (phase === 1 || phase === 2) ? 'block' : 'none';
            if (cfg3dgs) cfg3dgs.style.display = (phase === 3) ? 'block' : 'none';
            if (cfgSeg) cfgSeg.style.display = (phase === 4) ? 'block' : 'none';
            if (cfgVrexport) cfgVrexport.style.display = (phase === 5) ? 'block' : 'none';
            
            // Dynamic text logic handled in phase switch above
        } else {
            if (cfgPrep) cfgPrep.style.display = 'block';
            if (cfgColmap) cfgColmap.style.display = 'block';
            if (cfg3dgs) cfg3dgs.style.display = 'block';
            if (cfgSeg) cfgSeg.style.display = 'block';
            if (cfgVrexport) cfgVrexport.style.display = 'block';
            if (cfgVrexport) cfgVrexport.style.display = 'block';
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
        if (currentJobId && currentJobId !== 'new') {
            sessionStorage.setItem('vit_manifest_url', `${BACKEND_URL}/jobs/${currentJobId}/vr-assets/manifest.json`);
        }
        if (currentJobId && nextPhaseLabel && nextPhaseLabel.textContent.includes('Align in Renderer')) {
          window.location.hash = `#/renderer?align=${currentJobId}`;
        } else if (currentJobId && nextPhaseLabel && nextPhaseLabel.textContent.includes('Virtual Camera')) {
          window.location.hash = `#/renderer?vcam=${currentJobId}`;
        } else {
          router.goRenderer();
        }
      });

    // Toggle Dense visibility in UI
    if (cfgDense) {
        cfgDense.addEventListener('change', () => {
            if (stepRow2) stepRow2.style.display = cfgDense.checked ? 'grid' : 'none';
        });
    }

    const segVoteSlider = document.getElementById('cfg-seg-vote-ratio');
    const segVoteDisplay = document.getElementById('seg-vote-ratio-display');
    if (segVoteSlider && segVoteDisplay) {
        segVoteSlider.addEventListener('input', () => {
            segVoteDisplay.textContent = segVoteSlider.value;
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
            if (modeToggle) modeToggle.style.display = 'flex';
            if (uploadSection) uploadSection.style.display = 'block';
            if (uploadStatus) uploadStatus.textContent = '';
            
            // Clear logs and tree from previous runs
            if (logEl) logEl.innerHTML = '';
            currentLogDetails = null;
            currentLogContent = null;
            if (treeContainer) treeContainer.innerHTML = '';
            resetSteps();
            
            selectedFile = null;
            if (inputVideo) inputVideo.value = '';
            if (inputZip) inputZip.value = '';
            if (inputDir) inputDir.value = '';
            updateRunButtonsState();
            showConfig();
            return;
        }
        
        // Existing job — hide the mode toggle, it's irrelevant
        if (modeToggle) modeToggle.style.display = 'none';
        
        if (uploadSection) uploadSection.style.display = 'none'; 
        try {
            const res = await fetch(`${BACKEND_URL}/jobs/${jobId}`);
            if (!res.ok) throw new Error("Job not found");
            const job = await res.json();
            
            completedPhases = job.completed_phases || [];
            
            if (completedPhases.includes(5)) {
                sessionStorage.setItem('vit_manifest_url', `${BACKEND_URL}/jobs/${jobId}/vr-assets/manifest.json`);
            }
            
            renderResultsPanel();
            fetchAndRenderTree();

            if (job.status === "uploaded") {
                showConfig();
            } else {
                showProgress();
                resetSteps();
                completedPhases.forEach(pid => markStep(pid, 'done', 100));
                startWatching(jobId, job.status);
                if (job.status === "done") {
                    markAllDone();
                    if (viewBtn) viewBtn.disabled = false;
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
        if (cancelArea) cancelArea.style.display = 'none';
        if (viewBtn) viewBtn.disabled = true;
    }

    function showProgress() {
        if (configPanel) configPanel.style.display = 'none';
        if (stepsContainer) stepsContainer.style.display = 'block';
        if (phaseControl) phaseControl.style.display = 'none';
        if (cancelArea) cancelArea.style.display = 'none';  // only shown on step_start
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
            gs_sh_degree: parseInt(document.getElementById('cfg-gs-sh-degree')?.value || "3", 10),
            gs_white_background: document.getElementById('cfg-gs-white-bg')?.checked ?? false,
            gs_save_iterations: document.getElementById('cfg-gs-save-iters')?.value || "",
            gs_check_iterations: document.getElementById('cfg-gs-check-iters')?.value || "",
            gs_start_checkpoint: document.getElementById('cfg-gs-start-checkpoint')?.value || "",
            seg_custom_objects: document.getElementById('cfg-seg-objects')?.value || "",
            seg_vote_ratio: parseFloat(document.getElementById('cfg-seg-vote-ratio')?.value) || 0.5,
            seg_mode: document.getElementById('seg-mode-vcam')?.classList.contains('active-mode') ? 'vcam' : 'auto',
            vr_manual_align: document.getElementById('cfg-vr-manual-align')?.checked ?? false,
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
                const path = f.webkitRelativePath || f.name;
                zip.file(path, f);
            }
            if (uploadStatus) uploadStatus.textContent = 'Zipping files (0%)...';
            const zipBlob = await zip.generateAsync({ type: 'blob' }, (meta) => {
                if (uploadStatus) uploadStatus.textContent = `Zipping files (${Math.round(meta.percent)}%)...`;
            });
            filename = (projectName?.value.trim() || 'project') + '_upload.zip';
            fileToUpload = new File([zipBlob], filename, { type: 'application/zip' });
        } else {
            fileToUpload = selectedFile;
            filename = fileToUpload.name;
        }

        const formData = new FormData();
        formData.append('file', fileToUpload, filename);
        if (projectName && projectName.value) {
            formData.append('project_name', projectName.value);
        }
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
        if (stepRow2) stepRow2.style.display = config.colmap_dense_enable ? 'grid' : 'none';
        if (stepRow3) stepRow3.style.display = 'grid'; // Ensure 3DGS is always visible

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
        if (cancelArea) cancelArea.style.display = 'block';
        const config = getPreviewConfigData();
        
        // Reconnect websocket so we can hear updates from the newly started task
        startWatching(currentJobId, 'running');

        try {
            const res = await fetch(`${BACKEND_URL}/continue-pipeline`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ job_id: currentJobId, mode, config }),
            });
            if (!res.ok) throw new Error("Failed to continue pipeline");
        } catch (e) {
            alert(e.message);
            if (cancelArea) cancelArea.style.display = 'none';
        }
    }

    if (runBtn) runBtn.addEventListener('click', () => submitRun('step'));
    if (runAllBtn) runAllBtn.addEventListener('click', () => submitRun('all'));
    if (runSingleBtn) runSingleBtn.addEventListener('click', () => submitRun('step', true));
    if (continueBtn) continueBtn.addEventListener('click', () => submitContinue('step'));
    if (cancelBtn) cancelBtn.addEventListener('click', async () => {
        if (!currentJobId) return;
        if (!confirm('Cancel the current phase? Partial output will be deleted.')) return;
        try {
            const res = await fetch(`${BACKEND_URL}/cancel-pipeline`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ job_id: currentJobId }),
            });
            if (res.status === 409) {
                // Phase already finished between button click and request
                if (cancelArea) cancelArea.style.display = 'none';
                return;
            }
        } catch (e) {
            console.error('Cancel failed', e);
        }
    });

    // ── WebSocket connection ───────────────────────────────────────────────────
    // knownFinalStatus: if we already know the job is 'paused'/'done'/'cancelled',
    // pass it in so historical log replays don't accidentally hide phaseControl.
    async function startWatching(jobId, knownFinalStatus = null) {
        disconnectWS();
        
        currentLogDetails = null;
        currentLogContent = null;
        if (logEl) logEl.innerHTML = '';
        
        const isAlreadyFinished = ['paused', 'done', 'cancelled', 'failed'].includes(knownFinalStatus);
        
        try {
            const res = await fetch(`${BACKEND_URL}/jobs/${jobId}/logs`);
            if (res.ok) {
                const logs = await res.json();
                logs.forEach(msg => handleMessage(msg, /* isReplay= */ true, isAlreadyFinished));
            }
        } catch (e) {
            console.error("Could not fetch old logs", e);
        }
        
        ws = new WebSocket(`${BACKEND_WS}/progress/${jobId}`);

        ws.onmessage = (event) => {
            const msg = JSON.parse(event.data);
            handleMessage(msg, false, false);
        };

        ws.onerror = () => appendLog('[WebSocket error — is the backend running?]');
        ws.onclose = () => {};
    }

    function disconnectWS() {
        if (ws) { try { ws.close(); } catch(_) {} ws = null; }
    }

    // ── Message handling ───────────────────────────────────────────────────────
    // isReplay: true when replaying historical logs (not live)
    // isAlreadyFinished: true when we know the pipeline is no longer running
    function handleMessage(msg, isReplay = false, isAlreadyFinished = false) {
        if (msg.type === 'step_start') {
            markStep(msg.step, 'active', 0);
            appendLog(`Starting: ${msg.label}...`, true, false, msg.label);
            // Only hide phaseControl/show cancel if pipeline is actually running right now.
            // During historical replay of a completed job, don't flip these controls.
            if (!isAlreadyFinished) {
                if (phaseControl) phaseControl.style.display = 'none';
                if (cancelArea) cancelArea.style.display = 'block';
            }
        } else if (msg.type === 'log') {
            updateStepProgress(msg.step, msg.progress);
            appendLog(msg.text);
        } else if (msg.type === 'phase_complete') {
            completedPhases.push(msg.phase);
            markStep(msg.phase, 'done', 100);
            renderResultsPanel();
            fetchAndRenderTree();
            
            // If Phase 5 completes, point the renderer to its manifest
            if (msg.phase === 5) {
                sessionStorage.setItem('vit_manifest_url', `${BACKEND_URL}/jobs/${currentJobId}/vr-assets/manifest.json`);
            }
        } else if (msg.type === 'phase_paused') {
            if (cancelArea) cancelArea.style.display = 'none';
            if (msg.next_phase === null) {
                // Truly no next phase — pipeline will reach done on continue
                if (nextPhaseLabel) nextPhaseLabel.textContent = 'Finish';
                if (phaseConfigPreview) phaseConfigPreview.innerHTML = '';
                if (!isReplay || isAlreadyFinished) {
                    if (phaseControl) phaseControl.style.display = 'flex';
                }
            } else {
                if (nextPhaseLabel) nextPhaseLabel.textContent = msg.next_label || 'Next Phase';
                populatePhaseConfigPreview(msg.next_phase);
                if (!isReplay || isAlreadyFinished) {
                    if (phaseControl) phaseControl.style.display = 'flex';
                }
            }
            
            if (msg.next_phase === 5 && msg.next_label && msg.next_label.includes('Align in Renderer')) {
                if (viewBtn) viewBtn.disabled = false;
                if (continueBtn) continueBtn.style.display = 'none';
                if (phaseSummary) phaseSummary.innerHTML = `<strong style="color:#60a5fa">Paused for Alignment.</strong> Please click the "View in Renderer" button below to align your scene.`;
            } else if (msg.next_phase === 4 && msg.next_label && msg.next_label.includes('Virtual Camera')) {
                if (viewBtn) viewBtn.disabled = false;
                if (continueBtn) continueBtn.style.display = 'none';
                if (phaseSummary) phaseSummary.innerHTML = `<strong style="color:#60a5fa">Paused for Virtual Cameras.</strong> Please click the "View in Renderer" button below to place your cameras.`;
            } else {
                if (continueBtn) continueBtn.style.display = 'inline-block';
                if (phaseSummary) phaseSummary.innerHTML = '';
                if (viewBtn) viewBtn.disabled = true;
            }
        } else if (msg.type === 'cancelled') {
            markStep(msg.phase, 'error', 0);
            appendLog(`⚠ ${msg.label} cancelled. Partial output cleaned up.`, false, true);
            if (cancelArea) cancelArea.style.display = 'none';
            // Show retry option
            if (nextPhaseLabel) nextPhaseLabel.textContent = `Retry: ${msg.label}`;
            populatePhaseConfigPreview(msg.phase);
            if (phaseSummary) phaseSummary.innerHTML = `<strong style="color:#f87171">Phase cancelled.</strong> Adjust settings below and retry.`;
            if (phaseControl) phaseControl.style.display = 'flex';
            fetchAndRenderTree();
        } else if (msg.type === 'failed') {
            markStep(msg.phase, 'error', 0);
            appendLog(`❌ ${msg.label} failed. Partial output cleaned up.`, false, true);
            if (cancelArea) cancelArea.style.display = 'none';
            // Show retry option
            if (nextPhaseLabel) nextPhaseLabel.textContent = `Retry: ${msg.label}`;
            populatePhaseConfigPreview(msg.phase);
            if (phaseSummary) phaseSummary.innerHTML = `<strong style="color:#f87171">Phase failed: ${msg.error || 'Unknown error'}</strong> Adjust settings below and retry.`;
            if (phaseControl) phaseControl.style.display = 'flex';
            fetchAndRenderTree();
        } else if (msg.type === 'step_end') {
            markStep(msg.step, 'done', 100);
            appendLog(`✓ Step ${msg.step} complete.`);
            fetchAndRenderTree();
            if (msg.step === 5) {
                markAllDone();
                appendLog('✓ Pipeline complete.');
                if (viewBtn) viewBtn.disabled = false;
                if (cancelArea) cancelArea.style.display = 'none';
                if (phaseControl) phaseControl.style.display = 'none';
                if (msg.manifest_url) {
                    sessionStorage.setItem('vit_manifest_url', msg.manifest_url);
                }
            }
        } else if (msg.type === 'done') {
            markAllDone();
            appendLog('✓ Pipeline complete.');
            if (viewBtn) viewBtn.disabled = false;
            if (cancelArea) cancelArea.style.display = 'none';
            if (phaseControl) phaseControl.style.display = 'none';
        }
    }

    // ── Phase Config Preview ───────────────────────────────────────────────────
    const PHASE_CONFIG_SECTIONS = {
        1: ['cfg-section-prep', 'cfg-section-colmap'],
        2: ['cfg-section-colmap'],
        3: ['cfg-section-3dgs'],
        4: ['cfg-section-seg'],
        5: ['cfg-section-vrexport'],
    };

    function populatePhaseConfigPreview(nextPhase) {
        if (!phaseConfigPreview) return;
        phaseConfigPreview.innerHTML = '';
        const sectionIds = PHASE_CONFIG_SECTIONS[nextPhase] || [];
        if (sectionIds.length === 0) return;

        const wrapper = document.createElement('div');
        wrapper.style.cssText = 'background: rgba(255,255,255,0.04); border: 1px solid rgba(255,255,255,0.1); border-radius: 8px; padding: 16px;';
        const title = document.createElement('p');
        title.style.cssText = 'color: #9ca3af; font-size: 0.8rem; margin: 0 0 12px 0; text-transform: uppercase; letter-spacing: 0.05em;';
        title.textContent = 'Settings for next phase (edit before continuing)';
        wrapper.appendChild(title);

        sectionIds.forEach(id => {
            const section = document.getElementById(id);
            if (!section) return;
            const clone = section.cloneNode(true);
            // Remove the h3 section heading to keep it compact
            const h3 = clone.querySelector('h3');
            if (h3) h3.remove();
            // Suffix all IDs to avoid conflicts with the original config panel
            clone.querySelectorAll('[id]').forEach(el => {
                const oldId = el.id;
                el.id = `preview-${oldId}`;
            });
            clone.querySelectorAll('[for]').forEach(el => {
                el.setAttribute('for', `preview-${el.getAttribute('for')}`);
            });
            clone.style.background = 'none';
            clone.style.padding = '0';
            clone.style.display = 'block'; // Ensure it's visible even if the original was hidden
            wrapper.appendChild(clone);
        });
        
        // Add the wrapper first so it's in the DOM
        phaseConfigPreview.appendChild(wrapper);
        
        // Dynamically update UI if they toggle the manual align checkbox while paused
        const previewAlignBox = phaseConfigPreview.querySelector('#preview-cfg-vr-manual-align');
        if (previewAlignBox && nextPhase === 5) {
            previewAlignBox.addEventListener('change', (e) => {
                const isChecked = e.target.checked;
                const viewBtn = document.getElementById('pipeline-view-btn');
                const continueBtn = document.getElementById('phase-continue-btn');
                const phaseSummary = document.getElementById('phase-summary');
                const nextPhaseLabel = document.getElementById('next-phase-label');
                
                if (isChecked) {
                    if (viewBtn) viewBtn.disabled = false;
                    if (continueBtn) continueBtn.style.display = 'none';
                    if (phaseSummary) phaseSummary.innerHTML = `<strong style="color:#60a5fa">Paused for Alignment.</strong> Please click the "View in Renderer" button below to align your scene.`;
                    if (nextPhaseLabel) nextPhaseLabel.textContent = 'VR Export (Align in Renderer)';
                } else {
                    if (viewBtn) viewBtn.disabled = true;
                    if (continueBtn) continueBtn.style.display = 'inline-block';
                    if (phaseSummary) phaseSummary.innerHTML = '';
                    if (nextPhaseLabel) nextPhaseLabel.textContent = 'VR Export';
                }
            });
        }
    }

    function getPreviewConfigData() {
        const val = (id) => {
            const el = document.getElementById(`preview-${id}`);
            if (!el) return null;
            if (el.type === 'checkbox') return el.checked;
            return el.value || null;
        };
        const cfg = {};
        const frameRate = val('cfg-frame-rate');
        if (frameRate !== null) cfg.frame_rate = frameRate;
        const matcher = val('cfg-matcher');
        if (matcher !== null) cfg.colmap_matcher = matcher;
        const camera = val('cfg-camera-model');
        if (camera !== null) cfg.colmap_camera_model = camera;
        const quality = val('cfg-quality');
        if (quality !== null) cfg.colmap_quality = quality;
        const gpu = val('cfg-gpu');
        if (gpu !== null) cfg.colmap_use_gpu = gpu;
        const dense = val('cfg-dense');
        if (dense !== null) cfg.colmap_dense_enable = dense;
        const iter = val('cfg-gs-iterations');
        if (iter !== null) cfg.gs_iterations = parseInt(iter, 10);
        const res = val('cfg-gs-resolution');
        if (res !== null) cfg.gs_max_resolution = parseInt(res, 10);
        const sh = val('cfg-gs-sh-degree');
        if (sh !== null) cfg.gs_sh_degree = parseInt(sh, 10);
        const bg = val('cfg-gs-white-bg');
        if (bg !== null) cfg.gs_white_background = bg;
        const saveIters = val('cfg-gs-save-iters');
        if (saveIters !== null) cfg.gs_save_iterations = saveIters;
        const checkIters = val('cfg-gs-check-iters');
        if (checkIters !== null) cfg.gs_check_iterations = checkIters;
        const startCheck = val('cfg-gs-start-checkpoint');
        if (startCheck !== null) cfg.gs_start_checkpoint = startCheck;
        
        const segObjects = val('cfg-seg-objects');
        if (segObjects !== null) cfg.seg_custom_objects = segObjects;
        const segVoteRatio = val('cfg-seg-vote-ratio');
        if (segVoteRatio !== null) cfg.seg_vote_ratio = parseFloat(segVoteRatio) || 0.5;
        cfg.seg_mode = currentSegMode;
        
        const manualAlign = val('cfg-vr-manual-align');
        if (manualAlign !== null) cfg.vr_manual_align = manualAlign;
        
        return cfg;
    }

    function renderResultsPanel() {
        if (!resultsPanel || !resultsList) return;
        if (completedPhases.length === 0) {
            resultsPanel.style.display = 'none';
            return;
        }
        resultsPanel.style.display = 'block';
        resultsList.innerHTML = '';
        
        const downloadable = [...completedPhases].sort();
        
        downloadable.forEach(pid => {
            const step = STEPS.find(s => s.id === pid);
            const label = step ? step.label : `Phase ${pid}`;
            
            if (pid === 4) {
                const plyBtn = document.createElement('a');
                plyBtn.href = `${BACKEND_URL}/download/${currentJobId}/4`;
                plyBtn.target = '_blank';
                plyBtn.className = 'btn btn-secondary';
                plyBtn.innerHTML = '⬇ Download Labelled PLY';
                plyBtn.style.background = 'rgba(255,255,255,0.1)';
                plyBtn.style.border = '1px solid rgba(255,255,255,0.2)';
                plyBtn.style.color = 'white';
                resultsList.appendChild(plyBtn);

                const zipBtn = document.createElement('a');
                zipBtn.href = `${BACKEND_URL}/download/${currentJobId}/segmentation-zip`;
                zipBtn.target = '_blank';
                zipBtn.className = 'btn btn-secondary';
                zipBtn.innerHTML = '⬇ Download Segmentation ZIP';
                zipBtn.style.background = 'rgba(255,255,255,0.1)';
                zipBtn.style.border = '1px solid rgba(255,255,255,0.2)';
                zipBtn.style.color = 'white';
                resultsList.appendChild(zipBtn);

                const viewSegBtn = document.createElement('button');
                viewSegBtn.className = 'btn btn-primary';
                viewSegBtn.innerHTML = '🎮 Open in Renderer';
                viewSegBtn.disabled = true;
                viewSegBtn.title = 'Coming soon';
                viewSegBtn.style.opacity = '0.4';
                resultsList.appendChild(viewSegBtn);
            } else {
                const btn = document.createElement('a');
                btn.href = `${BACKEND_URL}/download/${currentJobId}/${pid}`;
                btn.target = '_blank';
                btn.className = 'btn btn-secondary';
                btn.innerHTML = `⬇ Download ${label}`;
                btn.style.background = 'rgba(255,255,255,0.1)';
                btn.style.border = '1px solid rgba(255,255,255,0.2)';
                btn.style.color = 'white';
                resultsList.appendChild(btn);
            }
        });

        if (completedPhases.includes(5)) {
            const exportBtn = document.createElement('a');
            exportBtn.href = `${BACKEND_URL}/jobs/${currentJobId}/export-engine`;
            exportBtn.className = 'btn btn-primary';
            exportBtn.innerHTML = `📦 Export Unity / Unreal Bundle`;
            exportBtn.style.background = 'linear-gradient(135deg, #4f46e5 0%, #3b82f6 100%)';
            exportBtn.style.border = 'none';
            exportBtn.style.color = 'white';
            exportBtn.style.fontWeight = 'bold';
            exportBtn.style.padding = '10px 20px';
            exportBtn.style.marginTop = '10px';
            exportBtn.style.display = 'inline-block';
            exportBtn.style.borderRadius = '6px';
            resultsList.appendChild(exportBtn);
        }
    }

    // ── Step UI helpers ────────────────────────────────────────────────────────
    function resetSteps() {
        if (phaseSummary) phaseSummary.innerHTML = '';
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

    function appendLog(text, isPhaseStart = false, isPhaseEnd = false, phaseLabel = "") {
        if (!logEl) return;
        
        if (isPhaseStart) {
            // Remove any existing log blocks for this phase if it's being retried to prevent double logs
            const matchText = phaseLabel || text;
            Array.from(logEl.querySelectorAll('details summary')).forEach(s => {
                if (s.textContent === matchText && s.parentElement) {
                    s.parentElement.remove();
                }
            });

            currentLogDetails = document.createElement('details');
            currentLogDetails.open = true;
            
            const summary = document.createElement('summary');
            summary.textContent = matchText;
            currentLogDetails.appendChild(summary);
            
            currentLogContent = document.createElement('div');
            currentLogContent.className = 'log-content';
            currentLogContent.textContent = text + '\n';
            currentLogDetails.appendChild(currentLogContent);
            
            logEl.appendChild(currentLogDetails);
        } else if (isPhaseEnd) {
            if (currentLogContent) {
                currentLogContent.textContent += text + '\n';
            }
            if (currentLogDetails) {
                currentLogDetails.open = false; // auto collapse
            }
        } else {
            if (!currentLogContent) {
                const fallback = document.createElement('div');
                fallback.className = 'log-content';
                fallback.textContent = text + '\n';
                logEl.appendChild(fallback);
                currentLogContent = fallback;
            } else {
                currentLogContent.textContent += text + '\n';
            }
        }
        
        logEl.scrollTop = logEl.scrollHeight;
    }

    // ── Directory Tree Fetching ────────────────────────────────────────────────
    const treePanel = document.getElementById('project-tree-panel');
    const treeContainer = document.getElementById('project-tree-container');

    async function fetchAndRenderTree() {
        if (!currentJobId || currentJobId === 'new') return;
        try {
            const res = await fetch(`${BACKEND_URL}/jobs/${currentJobId}/tree`);
            if (!res.ok) return;
            const treeData = await res.json();
            if (treePanel) treePanel.style.display = 'block';
            if (treeContainer) {
                treeContainer.innerHTML = '';
                treeContainer.appendChild(buildTreeHTML(treeData));
            }
        } catch (e) {
            console.error("Failed to fetch tree:", e);
        }
    }

    function buildTreeHTML(node) {
        if (node.type === 'file') {
            const li = document.createElement('li');
            li.className = 'tree-file';
            const kb = (node.size / 1024).toFixed(1);
            li.textContent = `📄 ${node.name} (${kb} KB)`;
            return li;
        } else {
            const li = document.createElement('li');
            
            const details = document.createElement('details');
            details.open = true;
            
            const summary = document.createElement('summary');
            summary.className = 'tree-folder';
            summary.textContent = node.name;
            details.appendChild(summary);
            
            const ul = document.createElement('ul');
            if (node.children) {
                node.children.forEach(child => {
                    ul.appendChild(buildTreeHTML(child));
                });
            }
            details.appendChild(ul);
            li.appendChild(details);
            
            return li;
        }
    }
}
