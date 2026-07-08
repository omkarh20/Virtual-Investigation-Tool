// Manifest Loader - for now it will just return dummy data

export class ManifestLoader {
    static async load() {
        // Look for manifest in sessionStorage (stashed by router.js) or URL
        let manifestUrl = sessionStorage.getItem('vit_manifest_url');
        if (!manifestUrl) {
            const urlParams = new URLSearchParams(window.location.search);
            manifestUrl = urlParams.get('manifest');
        }

        if (manifestUrl) {
            if (manifestUrl.includes('localhost:8000')) {
                manifestUrl = manifestUrl.replace('localhost:8000', '127.0.0.1:8000');
            }
            try {
                const response = await fetch(manifestUrl);
                if (!response.ok) {
                    throw new Error(`HTTP error! status: ${response.status}`);
                }
                const data = await response.json();
                data.baseUrl = manifestUrl.substring(0, manifestUrl.lastIndexOf('/'));
                return data;
            } catch (e) {
                console.error("Failed to load manifest from URL, falling back to dummy data", e);
            }
        }

        // Auto-load test.splat from the public folder
        console.log("Loading test.splat from public folder");
        return new Promise((resolve) => {
            setTimeout(() => {
                resolve({
                    scene_id: "test-scene",
                    baseUrl: "", // Base URL is empty so it fetches from the root (public folder)
                    segments: [
                        {
                            id: 1,
                            label: "My 3D Model",
                            file: "test_splat.ply",
                            collision: "test.glb", // Optional, will just fail gracefully if missing
                            bbox: { min: [-5, -5, -5], max: [5, 5, 5] },
                            centroid: [0, 0, 0],
                            movable: true
                        }
                    ]
                });
            }, 500);
        });
    }
}
