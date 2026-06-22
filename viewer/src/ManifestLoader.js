// Manifest Loader - for now it will just return dummy data

export class ManifestLoader {
    static async load() {
        // Look for manifest in URL
        const urlParams = new URLSearchParams(window.location.search);
        const manifestUrl = urlParams.get('manifest');

        if (manifestUrl) {
            try {
                const response = await fetch(manifestUrl);
                const data = await response.json();
                data.baseUrl = manifestUrl.substring(0, manifestUrl.lastIndexOf('/'));
                return data;
            } catch (e) {
                console.error("Failed to load manifest from URL, falling back to dummy data", e);
            }
        }

        // Dummy Data for testing UI and layout since we don't have .ply files
        console.log("Using dummy manifest data");
        return new Promise((resolve) => {
            setTimeout(() => {
                resolve({
                    scene_id: "dummy-scene-123",
                    segments: [
                        {
                            id: 0,
                            label: "background",
                            file: "dummy_bg.ply",
                            collision: "dummy_bg.glb",
                            bbox: { min: [-5, 0, -5], max: [5, 0.1, 5] },
                            centroid: [0, 0, 0],
                            movable: false
                        },
                        {
                            id: 1,
                            label: "knife",
                            file: "dummy_knife.ply",
                            collision: "dummy_knife.glb",
                            bbox: { min: [-0.1, 0, -0.1], max: [0.1, 0.05, 0.1] },
                            centroid: [-1, 0.5, -1],
                            movable: true
                        },
                        {
                            id: 2,
                            label: "chair",
                            file: "dummy_chair.ply",
                            collision: "dummy_chair.glb",
                            bbox: { min: [-0.5, 0, -0.5], max: [0.5, 1.5, 0.5] },
                            centroid: [2, 0.75, 1],
                            movable: true
                        }
                    ],
                    scene_collision: "dummy_scene.glb"
                });
            }, 500); // simulate network delay
        });
    }
}
