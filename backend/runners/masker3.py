import cv2
import torch
import numpy as np
import os
import argparse
from ultralytics import YOLO

# Suppress harmless model registry overwrite warnings from segment_anything_hq
import warnings
warnings.filterwarnings("ignore", category=UserWarning, module="segment_anything_hq")

# Import SAM HQ
from segment_anything_hq import sam_model_registry, SamPredictor

def get_args():
    parser = argparse.ArgumentParser(description="Hybrid YOLOE-26 & SAM HQ Smooth Mask Pipeline")
    
    BASE_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
    
    parser.add_argument(
        "--input_dir", 
        type=str, 
        default=os.path.join(BASE_DIR, "dev", "data", "FourItems"),
        help="Path to the folder containing input images"
    )
    parser.add_argument(
        "--master_dir", 
        type=str, 
        default=os.path.join(BASE_DIR, "dev", "outputs", "masker3_results"),
        help="Master directory where accurate masks will be saved"
    )
    return parser.parse_args()

def main():
    args = get_args()
    images_dir = args.input_dir
    masks_dir = args.master_dir

    if not os.path.exists(images_dir):
        print(f"[!] Error: Could not find the images directory at '{images_dir}'")
        return

    image_files = sorted([f for f in os.listdir(images_dir) if f.lower().endswith(('.jpg', '.jpeg', '.png'))])

    if not image_files:
        print(f"[!] No images found in '{images_dir}'.")
        return

    print("="*60)
    print("      VIRTUAL INVESTIGATION TOOL: HYBRID SMOOTH MASK GENERATOR")
    print("="*60)
    user_prompt = input("Enter custom objects to find (comma separated, e.g., 'cap, onion, book') or press Enter for Auto-Discovery: ").strip()
    custom_targets = [t.strip() for t in user_prompt.split(",")] if user_prompt else []

    device = "cuda" if torch.cuda.is_available() else "cpu"
    print(f"\n[*] Booting Models into VRAM ({device})...")
    
    # Set up checkpoints dir relative to this script
    BASE_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
    CHECKPOINTS_DIR = os.path.join(BASE_DIR, 'dev', 'checkpoints')

    # 1. Load YOLOE-26 (Weights auto-download via Ultralytics if not locally cached)
    if custom_targets:
        print("[*] Loading YOLOE-26 Text-Prompt architecture...")
        yoloe_model = YOLO(os.path.join(CHECKPOINTS_DIR, 'yoloe-26x-seg.pt'))
        yoloe_model.set_classes(custom_targets)
    else:
        print("[*] Loading YOLOE-26 Prompt-Free auto-discovery architecture...")
        yoloe_model = YOLO(os.path.join(CHECKPOINTS_DIR, 'yoloe-26x-seg-pf.pt'))
    
    # 2. Load SAM HQ for smooth contour refinement
    print("[*] Loading SAM HQ contour refiner...")
    sam = sam_model_registry["vit_h"](checkpoint=os.path.join(CHECKPOINTS_DIR, 'sam_hq_vit_h.pth')).to(device)
    predictor = SamPredictor(sam)

    print(f"\n[*] Starting batch processing for {len(image_files)} images...")

    for img_file in image_files:
        print(f"\n--- Processing: {img_file} ---")
        image_path = os.path.join(images_dir, img_file)
        
        base_name = os.path.splitext(img_file)[0]
        output_filename = f"{base_name}.png"

        image = cv2.imread(image_path)
        if image is None:
            print(f"[!] Could not read {img_file}, skipping.")
            continue
            
        image_rgb = cv2.cvtColor(image, cv2.COLOR_BGR2RGB)
        
        # Pass the frame to SAM HQ's image encoder once per frame
        predictor.set_image(image_rgb)
        
        image_masks = {}

        # Run inference using YOLOE-26 to get pristine, hallucination-free bounding boxes
        yoloe_results = yoloe_model.predict(image, verbose=False, device=device)
        result = yoloe_results[0]

        if result.boxes is not None and len(result.boxes) > 0:
            yoloe_boxes = result.boxes.xyxy.cpu().numpy()
            yoloe_classes = result.boxes.cls.cpu().numpy()
            yoloe_names = result.names

            print(f" -> YOLOE-26 verified {len(yoloe_boxes)} highly accurate object locations.")

            # Feed the exact coordinates into SAM HQ to draw smooth boundaries
            for i, box in enumerate(yoloe_boxes):
                label_name = yoloe_names[int(yoloe_classes[i])]
                clean_label = "".join(x for x in label_name if x.isalnum() or x in "_-").replace(" ", "_")
                
                # SAM HQ generates high-quality boundaries based on the target bounding box
                masks, _, _ = predictor.predict(box=np.array(box)[None, :], multimask_output=False)
                mask_array = masks[0] 
                
                if clean_label not in image_masks:
                    image_masks[clean_label] = mask_array
                else:
                    # Bitwise OR merges multiple items belonging to the same category
                    image_masks[clean_label] = image_masks[clean_label] | mask_array 
        else:
            print(" -> YOLOE-26 identified 0 valid target regions in this view.")

        # --- SAVE ALL HIGH-QUALITY MASKS ---
        for label, mask_array in image_masks.items():
            category_dir = os.path.join(masks_dir, label)
            os.makedirs(category_dir, exist_ok=True)
            
            mask_image = (mask_array * 255).astype(np.uint8)
            save_path = os.path.join(category_dir, output_filename)
            cv2.imwrite(save_path, mask_image)

    print("\n" + "="*60)
    print(f"[*] Pipeline Complete. Ultra-smooth masks saved to: {masks_dir}")
    print("="*60)

if __name__ == "__main__":
    main()