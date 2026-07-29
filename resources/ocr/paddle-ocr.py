#!/usr/bin/env python3
"""Persistent PP-OCRv6 bridge used by Fovea's Electron main process."""

from __future__ import annotations

import argparse
import contextlib
import importlib.metadata
import json
import os
import sys
import time
import traceback
from pathlib import Path
from typing import Any, TextIO


PROFILES = {
    "small": {
        "detector": "PP-OCRv6_small_det",
        "recognizer": "PP-OCRv6_small_rec",
    },
    "medium": {
        "detector": "PP-OCRv6_small_det",
        "recognizer": "PP-OCRv6_medium_rec",
    },
    "large": {
        "detector": "PP-OCRv6_medium_det",
        "recognizer": "PP-OCRv6_medium_rec",
    },
}

PROTOCOL_STDOUT = sys.stdout


def emit(payload: dict[str, Any], stream: TextIO = PROTOCOL_STDOUT) -> None:
    stream.write(json.dumps(payload, ensure_ascii=False, separators=(",", ":")) + "\n")
    stream.flush()


def configure_environment(cache_dir: str | None) -> None:
    os.environ.setdefault("PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK", "1")
    if cache_dir:
        cache_path = str(Path(cache_dir).resolve())
        Path(cache_path).mkdir(parents=True, exist_ok=True)
        os.environ["PADDLE_PDX_CACHE_HOME"] = cache_path


def package_version(name: str) -> str | None:
    try:
        return importlib.metadata.version(name)
    except importlib.metadata.PackageNotFoundError:
        return None


def check_environment() -> int:
    versions = {
        "python": sys.version.split()[0],
        "paddleocr": package_version("paddleocr"),
        "paddlepaddle": package_version("paddlepaddle"),
    }
    emit(
        {
            "type": "check",
            "available": bool(versions["paddleocr"] and versions["paddlepaddle"]),
            "versions": versions,
            "profiles": PROFILES,
        }
    )
    return 0 if versions["paddleocr"] and versions["paddlepaddle"] else 2


def load_pipeline(profile: str) -> Any:
    model = PROFILES[profile]
    started = time.perf_counter()
    with contextlib.redirect_stdout(sys.stderr):
        from paddleocr import PaddleOCR

        pipeline = PaddleOCR(
            text_detection_model_name=model["detector"],
            text_recognition_model_name=model["recognizer"],
            use_doc_orientation_classify=False,
            use_doc_unwarping=False,
            use_textline_orientation=False,
            text_rec_score_thresh=0.35,
            device="cpu",
            # PaddlePaddle 3.3.x currently crashes in the Windows CPU
            # oneDNN/PIR conversion path for PP-OCRv6. Keep the safe kernels
            # as the default while allowing an explicit opt-in for retesting.
            # PaddlePaddle 3.2.2 is pinned because its Windows oneDNN path is
            # compatible with PP-OCRv6. PaddlePaddle 3.3.x currently regresses
            # here with a PIR attribute-conversion failure.
            enable_mkldnn=os.environ.get("FOVEA_PADDLE_MKLDNN", "1") != "0",
            cpu_threads=max(1, min(os.cpu_count() or 4, 12)),
        )
    return pipeline, round((time.perf_counter() - started) * 1000)


def to_list(value: Any) -> list[Any]:
    if value is None:
        return []
    if hasattr(value, "tolist"):
        converted = value.tolist()
        return converted if isinstance(converted, list) else []
    return value if isinstance(value, list) else []


def result_data(result: Any) -> dict[str, Any]:
    value = getattr(result, "json", result)
    if callable(value):
        value = value()
    if not isinstance(value, dict):
        return {}
    nested = value.get("res")
    return nested if isinstance(nested, dict) else value


def rectangle_from_box(box: Any) -> list[float] | None:
    values = to_list(box)
    if len(values) == 4 and all(isinstance(value, (int, float)) for value in values):
        left, top, right, bottom = values
        return [float(left), float(top), float(right), float(bottom)]
    points = [to_list(point) for point in values]
    points = [
        point
        for point in points
        if len(point) >= 2
        and isinstance(point[0], (int, float))
        and isinstance(point[1], (int, float))
    ]
    if not points:
        return None
    xs = [float(point[0]) for point in points]
    ys = [float(point[1]) for point in points]
    return [min(xs), min(ys), max(xs), max(ys)]


def recognise(pipeline: Any, profile: str, image_path: str) -> dict[str, Any]:
    started = time.perf_counter()
    with contextlib.redirect_stdout(sys.stderr):
        predictions = list(
            pipeline.predict(
                input=str(Path(image_path).resolve()),
                use_doc_orientation_classify=False,
                use_doc_unwarping=False,
                use_textline_orientation=False,
                text_rec_score_thresh=0.35,
            )
        )
    inference_ms = round((time.perf_counter() - started) * 1000)
    lines: list[dict[str, Any]] = []
    for prediction in predictions:
        data = result_data(prediction)
        texts = to_list(data.get("rec_texts"))
        scores = to_list(data.get("rec_scores"))
        boxes = to_list(data.get("rec_boxes"))
        polygons = to_list(data.get("rec_polys"))
        for index, text in enumerate(texts):
            if not isinstance(text, str) or not text.strip():
                continue
            score = scores[index] if index < len(scores) else 0
            source_box = boxes[index] if index < len(boxes) else (
                polygons[index] if index < len(polygons) else None
            )
            bounds = rectangle_from_box(source_box)
            if bounds is None:
                continue
            lines.append(
                {
                    "text": text.strip(),
                    "confidence": float(score) if isinstance(score, (int, float)) else 0,
                    "bounds": bounds,
                }
            )
    model = PROFILES[profile]
    return {
        "profile": profile,
        "detector": model["detector"],
        "recognizer": model["recognizer"],
        "lines": lines,
        "inferenceMs": inference_ms,
    }


def serve(profile: str) -> int:
    pipeline, load_ms = load_pipeline(profile)
    model = PROFILES[profile]
    emit(
        {
            "type": "ready",
            "profile": profile,
            "detector": model["detector"],
            "recognizer": model["recognizer"],
            "loadMs": load_ms,
        }
    )
    for raw_line in sys.stdin:
        request: dict[str, Any] | None = None
        try:
            request = json.loads(raw_line)
            if not isinstance(request, dict) or request.get("type") != "recognise":
                continue
            request_id = str(request.get("requestId") or "")
            image_path = str(request.get("imagePath") or "")
            if not request_id or not image_path:
                raise ValueError("A requestId and imagePath are required.")
            emit(
                {
                    "type": "result",
                    "requestId": request_id,
                    **recognise(pipeline, profile, image_path),
                }
            )
        except Exception as error:  # Keep the server available after a bad image.
            emit(
                {
                    "type": "error",
                    "requestId": str(request.get("requestId") or "")
                    if isinstance(request, dict)
                    else "",
                    "message": str(error),
                }
            )
            traceback.print_exc(file=sys.stderr)
    return 0


def run_images(profile: str, image_paths: list[str]) -> int:
    pipeline, load_ms = load_pipeline(profile)
    emit({"type": "ready", "profile": profile, "loadMs": load_ms, **PROFILES[profile]})
    for image_path in image_paths:
        try:
            emit(
                {
                    "type": "result",
                    "file": image_path,
                    **recognise(pipeline, profile, image_path),
                }
            )
        except Exception as error:
            emit(
                {
                    "type": "error",
                    "file": image_path,
                    "profile": profile,
                    "message": str(error),
                }
            )
            traceback.print_exc(file=sys.stderr)
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description="Fovea PP-OCRv6 sidecar")
    parser.add_argument("--profile", choices=sorted(PROFILES), default="small")
    parser.add_argument("--cache-dir")
    parser.add_argument("--serve", action="store_true")
    parser.add_argument("--check", action="store_true")
    parser.add_argument("--warmup", action="store_true")
    parser.add_argument("--image", action="append", default=[])
    arguments = parser.parse_args()
    configure_environment(arguments.cache_dir)
    if arguments.check:
        return check_environment()
    if arguments.warmup:
        _, load_ms = load_pipeline(arguments.profile)
        emit(
            {
                "type": "ready",
                "profile": arguments.profile,
                "loadMs": load_ms,
                **PROFILES[arguments.profile],
            }
        )
        return 0
    if arguments.serve:
        return serve(arguments.profile)
    if arguments.image:
        return run_images(arguments.profile, arguments.image)
    parser.error("Choose --check, --warmup, --serve, or provide at least one --image.")
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
