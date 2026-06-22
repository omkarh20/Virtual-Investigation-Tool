import requests
import sys

def test_pipeline(file_path):
    print(f"Uploading {file_path} to backend...")
    
    # 1. Upload the PLY file to get a job_id
    try:
        with open(file_path, "rb") as f:
            resp = requests.post("http://localhost:8000/upload", files={"file": f})
    except Exception as e:
        print(f"Failed to connect to backend: {e}")
        print("Is the uvicorn server running on port 8000?")
        return
    
    if resp.status_code != 200:
        print("Upload failed:", resp.text)
        return
        
    data = resp.json()
    job_id = data["job_id"]
    print(f"Uploaded successfully. Job ID: {job_id}")
    
    # 2. Trigger the export pipeline
    print("Triggering VR Export (splitting and generating GLB files)...")
    export_resp = requests.post("http://localhost:8000/export-vr", json={"job_id": job_id})
    
    if export_resp.status_code != 200:
        print("Export failed:", export_resp.text)
        return
        
    export_data = export_resp.json()
    print("\n--- Export Successful! ---")
    print(f"Manifest URL: {export_data.get('manifest_url')}")
    print("\nYou can now open the Viewer in your browser and pass the manifest URL like this:")
    print(f"http://localhost:5173/?manifest={export_data.get('manifest_url')}")
    
if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: python test_export.py <path_to_ply_file>")
        sys.exit(1)
        
    test_pipeline(sys.argv[1])
