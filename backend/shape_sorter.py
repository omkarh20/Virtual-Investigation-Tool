import cv2
import numpy as np
import os
import shutil
import argparse

def preprocess_image(image_path):
    """
    Module 1: Preprocessor
    Input: image path
    Output: clean binary image
    """
    img = cv2.imread(image_path, cv2.IMREAD_GRAYSCALE)
    if img is None:
        return None
    
    # 1. Denoise
    blurred = cv2.GaussianBlur(img, (5, 5), 0)
    
    # 2. Threshold (Otsu's method)
    # Using THRESH_BINARY_INV to make objects white on black background, which is usually better for findContours
    _, binary = cv2.threshold(blurred, 128, 255, cv2.THRESH_BINARY_INV | cv2.THRESH_OTSU)
    
    # 3. Morphology
    kernel = np.ones((5, 5), np.uint8)
    binary = cv2.morphologyEx(binary, cv2.MORPH_OPEN, kernel)
    binary = cv2.morphologyEx(binary, cv2.MORPH_CLOSE, kernel)
    
    return binary

def extract_features(binary_img):
    """
    Module 2: Feature extractor
    Input: clean binary
    Output: Hu moments, area, perimeter, circularity, corners, and the contour
    """
    contours, _ = cv2.findContours(binary_img, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    if not contours:
        return None, None
        
    # Get largest contour
    largest = max(contours, key=cv2.contourArea)
    
    # A. Contour already extracted
    
    # B. Hu Moments
    moments = cv2.moments(largest)
    hu = cv2.HuMoments(moments).flatten()
    
    # Standard log transform for Hu moments to make them comparable
    for i in range(0, 7):
        if hu[i] != 0:
            hu[i] = -1 * np.copysign(1.0, hu[i]) * np.log10(abs(hu[i]))
            
    # C. Area
    area = cv2.contourArea(largest)
    
    # D. Perimeter
    perimeter = cv2.arcLength(largest, True)
    
    # E. Circularity
    if perimeter > 0:
        circularity = (4 * np.pi * area) / (perimeter * perimeter)
    else:
        circularity = 0
        
    # F. Corner count
    approx = cv2.approxPolyDP(largest, 0.04 * perimeter, True)
    corners = len(approx)
    
    # Create feature vector
    # Area and perimeter are not scale invariant, so they are typically excluded from the raw distance vector
    # But as per prompt, we extract all of them. We'll build the vector using scale-invariant features:
    feature_vector = np.concatenate([hu, [circularity, corners]])
    
    return feature_vector, largest

def train_folders(reference_dir):
    """
    Module 3: Folder trainer
    Input: reference folders
    Output: folder prototypes, folder contours
    """
    prototypes = {}
    print(f"Training on reference directory: {reference_dir}")
    
    if not os.path.exists(reference_dir):
        print(f"Reference directory '{reference_dir}' not found.")
        return prototypes
        
    for folder_name in os.listdir(reference_dir):
        folder_path = os.path.join(reference_dir, folder_name)
        if not os.path.isdir(folder_path):
            continue
            
        feature_list = []
        contour_list = []
        
        for file in os.listdir(folder_path):
            file_path = os.path.join(folder_path, file)
            binary_img = preprocess_image(file_path)
            if binary_img is not None:
                features, contour = extract_features(binary_img)
                if features is not None:
                    feature_list.append(features)
                    contour_list.append(contour)
                    
        if feature_list:
            # Average of all example features
            avg_features = np.mean(feature_list, axis=0)
            
            # Find the most representative contour (closest to average features)
            distances = [np.linalg.norm(f - avg_features) for f in feature_list]
            best_idx = np.argmin(distances)
            rep_contour = contour_list[best_idx]
            
            prototypes[folder_name] = {
                'features': avg_features,
                'contour': rep_contour
            }
            print(f"Trained {folder_name}: {len(feature_list)} samples.")
            
    return prototypes

def match_image(features, contour, prototypes):
    """
    Module 4: Matcher
    Input: new image features & contour, prototypes
    Output: best folder, confidence
    """
    scores = {}
    
    for folder_name, proto in prototypes.items():
        # Method A: Hu Moment distance using cv2.matchShapes
        shape_match = cv2.matchShapes(contour, proto['contour'], cv2.CONTOURS_MATCH_I1, 0)
        
        # Method B: Feature vector distance (Euclidean)
        feature_distance = np.linalg.norm(features - proto['features'])
        
        # Combine both
        final_score = 0.7 * shape_match + 0.3 * feature_distance
        scores[folder_name] = final_score
        
    if not scores:
        return None, 0.0
        
    # Lower is better
    best_folder = min(scores, key=scores.get)
    best_score = scores[best_folder]
    
    total_scores = sum(scores.values())
    
    if total_scores == 0:
        confidence = 1.0
    else:
        # Confidence formula from specification
        confidence = 1 - (best_score / total_scores)
        
    return best_folder, confidence

def sort_images(unsorted_dir, sorted_dir, prototypes, threshold=0.8):
    """
    Module 5: Sorter
    Input: prediction
    Output: physical file movement
    """
    if not os.path.exists(unsorted_dir):
        print(f"Unsorted directory '{unsorted_dir}' not found.")
        return
        
    # Setup output folders
    os.makedirs(sorted_dir, exist_ok=True)
    for folder_name in prototypes.keys():
        os.makedirs(os.path.join(sorted_dir, folder_name), exist_ok=True)
    review_dir = os.path.join(sorted_dir, 'Review')
    os.makedirs(review_dir, exist_ok=True)
    
    for file in os.listdir(unsorted_dir):
        file_path = os.path.join(unsorted_dir, file)
        if not os.path.isfile(file_path):
            continue
            
        print(f"Processing {file}...")
        binary_img = preprocess_image(file_path)
        if binary_img is None:
            print(f"  -> Failed to read or process image. Moving to Review.")
            shutil.move(file_path, os.path.join(review_dir, file))
            continue
            
        features, contour = extract_features(binary_img)
        if features is None:
            print(f"  -> No contour found. Moving to Review.")
            shutil.move(file_path, os.path.join(review_dir, file))
            continue
            
        best_folder, confidence = match_image(features, contour, prototypes)
        if best_folder:
            print(f"  -> Best match: {best_folder} (Score: {(1-confidence):.3f}, Conf: {confidence:.3f})")
            if confidence >= threshold:
                target_folder = os.path.join(sorted_dir, best_folder)
            else:
                print(f"  -> Confidence {confidence:.3f} below threshold {threshold}. Moving to Review.")
                target_folder = review_dir
                
            # Move file
            target_path = os.path.join(target_folder, file)
            shutil.move(file_path, target_path)

def main():
    parser = argparse.ArgumentParser(description="Shape Similarity Image Sorter")
    parser.add_argument("--unsorted", default="unsorted", help="Directory containing unsorted images")
    parser.add_argument("--reference", default="reference", help="Directory containing reference shape folders")
    parser.add_argument("--output", default="sorted", help="Directory for sorted output")
    parser.add_argument("--threshold", type=float, default=0.80, help="Confidence threshold (default 0.80)")
    args = parser.parse_args()
    
    print("--- Shape Similarity Image Sorter ---")
    
    # 1. Train Folders
    prototypes = train_folders(args.reference)
    if not prototypes:
        print("No prototypes built. Please populate the reference directory with subfolders containing example images.")
        return
        
    print(f"Successfully built {len(prototypes)} prototypes.")
    
    # 2. Sort Images
    print("\nSorting unsorted images...")
    sort_images(args.unsorted, args.output, prototypes, threshold=args.threshold)
    print("Sorting complete.")

if __name__ == "__main__":
    main()
