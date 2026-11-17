"""Build the disk-code recogniser shipped with the app (seed/models/ppocr_rec.onnx).

Source: PaddleOCR's ``ch_PP-OCRv3_rec`` recogniser exported to ONNX, as shipped
by RapidOCR (``rapidocr_onnxruntime==1.2.3`` on PyPI, file
``rapidocr_onnxruntime/models/ch_PP-OCRv3_rec_infer.onnx``, 10.7 MB,
sha256 897a3ede...e615). Licence: Apache-2.0 (PaddleOCR and RapidOCR).

The original network classifies every time step into 6625 classes (Chinese,
Latin, digits, punctuation). Disk codes only use ``A-Z 0-9``, so

1. the last linear layer is cut to the CTC blank + those 36 characters. The
   softmax over the kept logits is exactly the renormalised restriction of the
   original output that the decoder used anyway (same results, 8.9 MB);
2. the large weights are stored in half precision (``--precision fp16``, the
   default, 4.5 MB) or as int8 with one scale per output channel
   (``int8``, 2.4 MB), and converted back to float32 by the graph itself
   (Cast [+ Mul]): the arithmetic stays in float32, so the model runs on any
   onnxruntime / onnxruntime-web backend. On the sample plates fp16 gives the
   same readings as the original; int8 loses one disk (docs/disk-reading.md).

usage (from backend/):
  .venv/bin/python scripts/build_ocr_model.py <ch_PP-OCRv3_rec_infer.onnx> [--precision fp32|fp16|int8]
Needs the ``onnx`` package (only for this script, not at runtime).
"""

from __future__ import annotations

import argparse
import hashlib
from pathlib import Path

import numpy as np
import onnx
from onnx import TensorProto, helper, numpy_helper

SOURCE_SHA256 = "897a3ededb38fee0dae2c1ccee38241f37df202c9509e3abca02e9217c5ee615"
CHARS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ"
TARGET = Path(__file__).resolve().parent.parent / "seed" / "models" / "ppocr_rec.onnx"
MIN_SIZE = 4096   # small tensors (biases, norms, shapes) stay as they are


def build(source: Path, precision: str) -> onnx.ModelProto:
    digest = hashlib.sha256(source.read_bytes()).hexdigest()
    if digest != SOURCE_SHA256:
        raise SystemExit(f"unexpected source model (sha256 {digest})")
    model = onnx.load(str(source))
    graph = model.graph
    meta = {p.key: p.value for p in model.metadata_props}
    # PaddleOCR CTCLabelDecode layout: blank, dictionary characters, space.
    classes = ["<blank>"] + meta["character"].splitlines() + [" "]
    keep = [0] + [classes.index(c) for c in CHARS]

    softmax = graph.node[-1]
    add = next(n for n in graph.node if n.op_type == "Add" and softmax.input[0] in n.output)
    matmul = next(n for n in graph.node if n.op_type == "MatMul" and add.input[0] in n.output)
    head = {matmul.input[1]: 1, add.input[1]: 0}   # weight (in, out) and bias (out,): axis of the classes
    # Output-channel axis of the weights: Conv (out, in, kh, kw) -> 0, MatMul (in, out) -> 1.
    channel_axis = {n.input[1]: 0 if n.op_type == "Conv" else 1 for n in graph.node if n.op_type in ("Conv", "MatMul")}

    nodes, decode = [], []
    for node in graph.node:
        name = node.output[0]
        array = numpy_helper.to_array(node.attribute[0].t) if node.op_type == "Constant" else None
        if array is None or (name not in head and (array.dtype != np.float32 or array.size < MIN_SIZE)):
            nodes.append(node)
            continue
        if name in head:
            array = np.take(array, keep, axis=head[name])
        if precision == "fp32" or array.size < MIN_SIZE:
            graph.initializer.append(numpy_helper.from_array(np.ascontiguousarray(array), name))
        elif precision == "fp16":
            graph.initializer.append(numpy_helper.from_array(array.astype(np.float16), name + "_h"))
            decode.append(helper.make_node("Cast", [name + "_h"], [name], to=TensorProto.FLOAT))
        else:
            ax = channel_axis.get(name)
            reduce = tuple(i for i in range(array.ndim) if i != ax) if ax is not None else None
            scale = (np.maximum(np.abs(array).max(axis=reduce, keepdims=True), 1e-8) / 127).astype(np.float32)
            q = np.clip(np.round(array / scale), -127, 127).astype(np.int8)
            graph.initializer.extend([numpy_helper.from_array(q, name + "_q"),
                                      numpy_helper.from_array(scale, name + "_scale")])
            decode += [helper.make_node("Cast", [name + "_q"], [name + "_f"], to=TensorProto.FLOAT),
                       helper.make_node("Mul", [name + "_f", name + "_scale"], [name])]
    del graph.node[:]
    graph.node.extend(decode + nodes)

    out = graph.output[0].type.tensor_type.shape.dim
    out[-1].ClearField("dim_param")
    out[-1].dim_value = len(keep)
    del model.metadata_props[:]
    helper.set_model_props(model, {
        "character": "\n".join(CHARS),
        "source": f"PaddleOCR ch_PP-OCRv3_rec (RapidOCR 1.2.3 ONNX, sha256 {SOURCE_SHA256}), Apache-2.0",
        "modified": f"classifier cut to CTC blank + 0-9 A-Z; {precision} weights",
    })
    onnx.checker.check_model(model)
    return model


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("source", type=Path)
    parser.add_argument("--precision", choices=["fp32", "fp16", "int8"], default="fp16")
    parser.add_argument("--out", type=Path, default=TARGET)
    args = parser.parse_args()
    model = build(args.source, args.precision)
    args.out.parent.mkdir(parents=True, exist_ok=True)
    onnx.save(model, str(args.out))
    data = args.out.read_bytes()
    print(f"{args.out}: {len(data) / 1e6:.2f} MB, sha256 {hashlib.sha256(data).hexdigest()}")


if __name__ == "__main__":
    main()
