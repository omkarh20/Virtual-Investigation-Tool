import os
import zipfile
import shutil
import asyncio
from typing import Callable, Awaitable

async def process_inputs(job_id: str, input_dir: str, images_dir: str, config: dict, push_ws: Callable[[dict], Awaitable[None]]):
    """
    Processes the raw inputs in `input_dir` and populates `images_dir` with final images for COLMAP.
    """
    os.makedirs(images_dir, exist_ok=True)
    
    files = os.listdir(input_dir)
    if not files:
        raise ValueError("No input files found in input directory.")
        
    video_exts = {".mp4", ".mov", ".avi", ".mkv"}
    image_exts = {".jpg", ".jpeg", ".png"}
    
    # 1. Check for ZIP files
    zip_files = [f for f in files if f.endswith(".zip")]
    if zip_files:
        await push_ws({"type": "log", "step": 1, "progress": 10, "text": "Extracting ZIP archive..."})
        zip_path = os.path.join(input_dir, zip_files[0])
        extract_dir = os.path.join(input_dir, "extracted_zip")
        os.makedirs(extract_dir, exist_ok=True)
        with zipfile.ZipFile(zip_path, 'r') as zip_ref:
            zip_ref.extractall(extract_dir)
            
        count = 0
        for root, _, extracted_files in os.walk(extract_dir):
            for f in extracted_files:
                if any(f.lower().endswith(ext) for ext in image_exts):
                    count += 1
                    ext = os.path.splitext(f)[1]
                    new_name = f"frame_{count:05d}{ext}"
                    shutil.copy(os.path.join(root, f), os.path.join(images_dir, new_name))
        await push_ws({"type": "log", "step": 1, "progress": 100, "text": f"Extracted {count} images from ZIP."})
        return

    # 2. Check for Video files
    videos = [f for f in files if any(f.lower().endswith(ext) for ext in video_exts)]
    if videos:
        await push_ws({"type": "log", "step": 1, "progress": 10, "text": "Extracting frames from video..."})
        video_path = os.path.join(input_dir, videos[0])
        frame_rate = str(config.get("frame_rate", "2"))
        
        vf_args = []
        if frame_rate != "all":
            vf_args = ["-vf", f"fps={frame_rate}"]
            
        cmd = [
            "ffmpeg", "-y", "-i", video_path,
        ] + vf_args + [
            "-qscale:v", "2",
            os.path.join(images_dir, "frame_%05d.jpg")
        ]
        
        process = await asyncio.create_subprocess_exec(
            *cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE
        )
        stdout, stderr = await process.communicate()
        if process.returncode != 0:
            raise RuntimeError(f"ffmpeg failed: {stderr.decode()}")
            
        num_frames = len(os.listdir(images_dir))
        await push_ws({"type": "log", "step": 1, "progress": 100, "text": f"Extracted {num_frames} frames from video."})
        return

    # 3. Assume multiple images directly uploaded
    images = [f for f in files if any(f.lower().endswith(ext) for ext in image_exts)]
    if images:
        await push_ws({"type": "log", "step": 1, "progress": 10, "text": "Processing uploaded images..."})
        count = 0
        for f in sorted(images):
            count += 1
            ext = os.path.splitext(f)[1]
            new_name = f"frame_{count:05d}{ext}"
            shutil.copy(os.path.join(input_dir, f), os.path.join(images_dir, new_name))
        await push_ws({"type": "log", "step": 1, "progress": 100, "text": f"Processed {count} images."})
        return

    raise ValueError("No valid video, ZIP, or image files found in input.")
