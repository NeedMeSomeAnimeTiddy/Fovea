import argparse
import json
import math
import os
import sys
import threading
import time
import traceback
from pathlib import Path

from PIL import Image


def emit(payload):
    print(json.dumps(payload, ensure_ascii=False, separators=(",", ":")), flush=True)


def parse_arguments():
    parser = argparse.ArgumentParser(description="Persistent OmniParser screenshot detector bridge")
    parser.add_argument("--serve", action="store_true")
    parser.add_argument("--check", action="store_true")
    parser.add_argument("--root", required=True)
    parser.add_argument("--model")
    parser.add_argument("--face-model")
    parser.add_argument("--device", default="auto")
    parser.add_argument("--confidence", type=float, default=0.08)
    parser.add_argument("--face-confidence", type=float, default=0.82)
    parser.add_argument("--tile-size", type=int, default=1280)
    parser.add_argument("--tile-overlap", type=float, default=0.125)
    parser.add_argument("--full-frame-long-side", type=int, default=1920)
    parser.add_argument("--full-native", action="store_true")
    parser.add_argument("--max-detections", type=int, default=500)
    return parser.parse_args()


def resolve_paths(arguments):
    root = Path(arguments.root).resolve()
    model = Path(arguments.model).resolve() if arguments.model else root / "weights" / "icon_detect_v3" / "model.pt"
    module = root / "util" / "yolov9.py"
    if not module.is_file():
        raise FileNotFoundError(f"OmniParser YOLOv9 module not found: {module}")
    if not model.is_file():
        raise FileNotFoundError(
            f"OmniParser icon_detect_v3 weight not found: {model}. "
            "Run npm run omniparser:setup."
        )
    return root, model


def load_icon_detector(arguments, root, model_path):
    if str(root) not in sys.path:
        sys.path.insert(0, str(root))
    from util.yolov9 import YOLOv9Detector

    device = None if arguments.device == "auto" else arguments.device
    return YOLOv9Detector(model_path=model_path, device=device)


def load_face_detector(arguments):
    root, model_path = resolve_paths(arguments)
    face_detector = None
    face_model_path = Path(arguments.face_model).resolve() if arguments.face_model else None
    if face_model_path:
        if not face_model_path.is_file():
            raise FileNotFoundError(f"YuNet face detector model not found: {face_model_path}")
        import cv2
        face_detector = cv2.FaceDetectorYN.create(
            str(face_model_path),
            "",
            (320, 320),
            clamp(arguments.face_confidence, 0.5, 0.99),
            0.3,
            5000,
        )
    return face_detector, root, model_path, face_model_path


def clamp(value, minimum, maximum):
    return max(minimum, min(maximum, value))


def axis_starts(length, tile_size, overlap):
    if length <= tile_size:
        return [0]
    step = max(32, int(tile_size * (1 - overlap)))
    starts = list(range(0, max(1, length - tile_size + 1), step))
    last = length - tile_size
    if starts[-1] != last:
        starts.append(last)
    return starts


def intersection_area(left, right):
    return max(0.0, min(left["x2"], right["x2"]) - max(left["x1"], right["x1"])) * max(
        0.0, min(left["y2"], right["y2"]) - max(left["y1"], right["y1"])
    )


def area(detection):
    return max(0.0, detection["x2"] - detection["x1"]) * max(0.0, detection["y2"] - detection["y1"])


def overlap_metrics(left, right):
    intersection = intersection_area(left, right)
    left_area = area(left)
    right_area = area(right)
    union = left_area + right_area - intersection
    return (
        intersection / union if union > 0 else 0.0,
        intersection / min(left_area, right_area) if min(left_area, right_area) > 0 else 0.0,
    )


def prefer_detection(left, right):
    left_area = area(left)
    right_area = area(right)
    if left["source"] != right["source"]:
        tile = left if left["source"] == "tile" else right
        full = right if tile is left else left
        if tile["confidence"] >= full["confidence"] - 0.08 and area(tile) <= area(full) * 1.35:
            return tile
    if abs(left["confidence"] - right["confidence"]) > 0.03:
        return left if left["confidence"] > right["confidence"] else right
    # For near-identical nested proposals, the outer region is normally the
    # clickable control while the inner region is its glyph.
    return left if left_area >= right_area else right


def deduplicate(detections, maximum):
    output = []
    for detection in sorted(
        detections,
        key=lambda candidate: (
            candidate["confidence"],
            1 if candidate["source"] == "tile" else 0,
            area(candidate),
        ),
        reverse=True,
    ):
        duplicate_index = None
        for index, candidate in enumerate(output):
            iou, containment = overlap_metrics(detection, candidate)
            if iou >= 0.55 or containment >= 0.88:
                duplicate_index = index
                break
        if duplicate_index is None:
            output.append(detection)
        else:
            output[duplicate_index] = prefer_detection(output[duplicate_index], detection)
    return sorted(output, key=lambda candidate: candidate["confidence"], reverse=True)[:maximum]


def model_detections(model, image, confidence, image_size, source, origin, screen_size, max_detections):
    result = model.predict(
        source=image,
        conf=confidence,
        imgsz=image_size,
        iou=0.25,
        max_det=max_detections,
    )[0]
    boxes = result.boxes.xyxy.detach().cpu().tolist()
    scores = result.boxes.conf.detach().cpu().tolist()
    screen_width, screen_height = screen_size
    origin_x, origin_y = origin
    detections = []
    for box, score in zip(boxes, scores):
        x1 = clamp(float(box[0]) + origin_x, 0, screen_width)
        y1 = clamp(float(box[1]) + origin_y, 0, screen_height)
        x2 = clamp(float(box[2]) + origin_x, 0, screen_width)
        y2 = clamp(float(box[3]) + origin_y, 0, screen_height)
        width = x2 - x1
        height = y2 - y1
        screen_area = max(1, screen_width * screen_height)
        if width < 3 or height < 3 or width * height < 16 or width * height / screen_area > 0.22:
            continue
        detections.append({
            "x1": x1,
            "y1": y1,
            "x2": x2,
            "y2": y2,
            "confidence": round(float(score), 6),
            "source": source,
        })
    return detections


def serialise(detections, screen_size):
    screen_width, screen_height = screen_size
    return [{
        "confidence": detection["confidence"],
        "source": detection["source"],
        "kind": detection.get("kind", "control"),
        "bounds": [
            round(detection["x1"] / screen_width, 8),
            round(detection["y1"] / screen_height, 8),
            round((detection["x2"] - detection["x1"]) / screen_width, 8),
            round((detection["y2"] - detection["y1"]) / screen_height, 8),
        ],
    } for detection in detections]


def face_detections(detector, image, confidence):
    if detector is None:
        return []
    import cv2
    import numpy as np

    screen_width, screen_height = image.size
    rgb = np.asarray(image)
    bgr = cv2.cvtColor(rgb, cv2.COLOR_RGB2BGR)
    inputs = [(bgr, 1.0, "face-native")]
    longest_side = max(screen_width, screen_height)
    if longest_side > 1920:
        scale = 1920 / longest_side
        inputs.append((
            cv2.resize(
                bgr,
                (max(1, round(screen_width * scale)), max(1, round(screen_height * scale))),
                interpolation=cv2.INTER_AREA,
            ),
            scale,
            "face-scaled",
        ))

    detections = []
    for detector_input, scale, source in inputs:
        input_height, input_width = detector_input.shape[:2]
        detector.setScoreThreshold(confidence)
        detector.setInputSize((input_width, input_height))
        _, faces = detector.detect(detector_input)
        if faces is None:
            continue
        for face in faces:
            x, y, width, height = [float(value) / scale for value in face[:4]]
            score = float(face[-1])
            if width < 7 or height < 7:
                continue
            # Include the forehead, chin, and a little surrounding context so the
            # crop sent to the response window is useful for visual identification.
            x1 = clamp(x - width * 0.10, 0, screen_width)
            y1 = clamp(y - height * 0.16, 0, screen_height)
            x2 = clamp(x + width * 1.10, 0, screen_width)
            y2 = clamp(y + height * 1.14, 0, screen_height)
            if x2 - x1 < 7 or y2 - y1 < 7:
                continue
            detections.append({
                "x1": x1,
                "y1": y1,
                "x2": x2,
                "y2": y2,
                "confidence": round(score, 6),
                "source": source,
                "kind": "face",
            })
    return deduplicate(detections, 100)


def analyse(icon_model, face_detector, request, arguments):
    image_path = request.get("imagePath")
    if not isinstance(image_path, str) or not image_path:
        raise ValueError("imagePath is required")
    confidence = clamp(float(request.get("confidence", arguments.confidence)), 0.01, 0.95)
    tile_size = max(512, min(2048, int(request.get("tileSize", arguments.tile_size))))
    tile_overlap = clamp(float(request.get("tileOverlap", arguments.tile_overlap)), 0.05, 0.35)
    full_frame_long_side = max(
        960,
        min(4096, int(request.get("fullFrameLongSide", arguments.full_frame_long_side))),
    )
    full_native = request.get("fullNative") is True or arguments.full_native
    maximum = max(20, min(1000, int(request.get("maxDetections", arguments.max_detections))))

    started_at = time.perf_counter()
    with Image.open(image_path) as source_image:
        image = source_image.convert("RGB")
    width, height = image.size
    if width < 2 or height < 2:
        raise ValueError("The frozen screen image is empty")

    face_started_at = time.perf_counter()
    faces = face_detections(
        face_detector,
        image,
        clamp(float(request.get("faceConfidence", arguments.face_confidence)), 0.5, 0.99),
    )
    face_ms = round((time.perf_counter() - face_started_at) * 1000)
    if face_detector is not None:
        emit({
            "type": "progress",
            "requestId": request.get("requestId"),
            "stage": "faces",
            "detections": serialise(faces, (width, height)),
            "inferenceMs": face_ms,
            "width": width,
            "height": height,
        })

    # The heavyweight icon model prewarms independently. Waiting for it here
    # cannot hold back the already-emitted frozen-screen face targets.
    model = icon_model()

    if full_native or max(width, height) <= full_frame_long_side:
        full_image_size = (height, width)
    else:
        scale = full_frame_long_side / max(width, height)
        full_image_size = (
            max(32, int(math.ceil(height * scale / 32) * 32)),
            max(32, int(math.ceil(width * scale / 32) * 32)),
        )
    full_started_at = time.perf_counter()
    full = model_detections(
        model,
        image,
        confidence,
        full_image_size,
        "full",
        (0, 0),
        (width, height),
        maximum,
    )
    full = deduplicate(full, maximum)
    full_ms = round((time.perf_counter() - full_started_at) * 1000)
    emit({
        "type": "progress",
        "requestId": request.get("requestId"),
        "stage": "full",
        "detections": serialise([*faces, *full], (width, height)),
        "inferenceMs": full_ms,
        "width": width,
        "height": height,
    })

    tiles = []
    tile_count = 0
    tile_started_at = time.perf_counter()
    x_starts = axis_starts(width, tile_size, tile_overlap)
    y_starts = axis_starts(height, tile_size, tile_overlap)
    needs_native_refinement = (
        len(x_starts) > 1 or
        len(y_starts) > 1 or
        full_image_size != (height, width)
    )
    if needs_native_refinement:
        for top in y_starts:
            for left in x_starts:
                right = min(width, left + tile_size)
                bottom = min(height, top + tile_size)
                crop = image.crop((left, top, right, bottom))
                tile_count += 1
                candidates = model_detections(
                    model,
                    crop,
                    confidence,
                    (crop.height, crop.width),
                    "tile",
                    (left, top),
                    (width, height),
                    maximum,
                )
                border = 4
                for candidate in candidates:
                    touches_internal_edge = (
                        (left > 0 and candidate["x1"] <= left + border) or
                        (top > 0 and candidate["y1"] <= top + border) or
                        (right < width and candidate["x2"] >= right - border) or
                        (bottom < height and candidate["y2"] >= bottom - border)
                    )
                    if not touches_internal_edge:
                        tiles.append(candidate)
    tile_ms = round((time.perf_counter() - tile_started_at) * 1000)
    combined = deduplicate([*full, *tiles], maximum)
    return {
        "type": "result",
        "requestId": request.get("requestId"),
        "detections": serialise([*faces, *combined], (width, height)),
        "inferenceMs": round((time.perf_counter() - started_at) * 1000),
        "width": width,
        "height": height,
        "diagnostics": {
            "fullFrameSize": [full_image_size[1], full_image_size[0]],
            "faceDetections": len(faces),
            "faceInferenceMs": face_ms,
            "fullDetections": len(full),
            "fullInferenceMs": full_ms,
            "tileSize": tile_size,
            "tileOverlap": tile_overlap,
            "tileCount": tile_count,
            "tileDetections": len(tiles),
            "tileInferenceMs": tile_ms,
            "combinedDetections": len(combined),
        },
    }


def serve(face_detector, arguments, root, model_path, face_model_path, face_load_ms):
    icon_state = {"model": None, "error": None}
    icon_ready = threading.Event()

    def prepare_icon_detector():
        started_at = time.perf_counter()
        try:
            model = load_icon_detector(arguments, root, model_path)
            icon_state["model"] = model
            emit({
                "type": "model-ready",
                "model": "icon_detect_v3",
                "modelPath": str(model_path),
                "device": str(model.device),
                "loadMs": round((time.perf_counter() - started_at) * 1000),
            })
        except Exception as error:
            icon_state["error"] = error
            traceback.print_exc(file=sys.stderr)
        finally:
            icon_ready.set()

    def get_icon_detector():
        icon_ready.wait()
        if icon_state["error"] is not None:
            raise RuntimeError(f"OmniParser icon model failed to load: {icon_state['error']}")
        return icon_state["model"]

    emit({
        "type": "ready",
        "model": "YuNet face detector" if face_detector is not None else "screenshot detector bridge",
        "modelPath": str(face_model_path) if face_model_path else None,
        "faceModelPath": str(face_model_path) if face_model_path else None,
        "device": "cpu",
        "loadMs": face_load_ms,
    })
    threading.Thread(target=prepare_icon_detector, name="omniparser-prewarm", daemon=True).start()
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        request_id = None
        try:
            request = json.loads(line)
            request_id = request.get("requestId")
            if request.get("type") != "detect":
                raise ValueError("Unsupported request type")
            emit(analyse(get_icon_detector, face_detector, request, arguments))
        except Exception as error:
            traceback.print_exc(file=sys.stderr)
            emit({
                "type": "error",
                "requestId": request_id,
                "message": str(error),
            })


def main():
    arguments = parse_arguments()
    if arguments.check:
        root, model = resolve_paths(arguments)
        face_model = Path(arguments.face_model).resolve() if arguments.face_model else None
        if face_model and not face_model.is_file():
            raise FileNotFoundError(f"YuNet face detector model not found: {face_model}")
        if face_model:
            import cv2
            cv2.FaceDetectorYN.create(str(face_model), "", (320, 320))
        emit({
            "type": "check",
            "root": str(root),
            "modelPath": str(model),
            "faceModelPath": str(face_model) if face_model else None,
        })
        return
    if not arguments.serve:
        raise ValueError("Use --serve or --check")
    started_at = time.perf_counter()
    face_detector, root, model_path, face_model_path = load_face_detector(arguments)
    face_load_ms = round((time.perf_counter() - started_at) * 1000)
    serve(face_detector, arguments, root, model_path, face_model_path, face_load_ms)


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        traceback.print_exc(file=sys.stderr)
        emit({"type": "fatal", "message": str(error)})
        sys.exit(1)
