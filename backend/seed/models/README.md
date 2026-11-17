# Disk-code OCR model

`ppocr_rec.onnx` — text-line recogniser used to read the code printed on antibiotic disks
(`backend/app/cv/reading.py`, `frontend/src/browser/ocr.ts`; see `docs/disk-reading.md`).

- **Origin:** PaddleOCR `ch_PP-OCRv3_rec` recogniser (https://github.com/PaddlePaddle/PaddleOCR), in the ONNX
  export shipped by RapidOCR (`rapidocr_onnxruntime==1.2.3` on PyPI,
  `rapidocr_onnxruntime/models/ch_PP-OCRv3_rec_infer.onnx`, 10.7 MB,
  sha256 `897a3ededb38fee0dae2c1ccee38241f37df202c9509e3abca02e9217c5ee615`).
- **Licence:** Apache License 2.0 (PaddleOCR and RapidOCR), http://www.apache.org/licenses/LICENSE-2.0.
- **Changes** (made by `backend/scripts/build_ocr_model.py`): the output layer is cut from 6625 classes to the CTC
  blank + `0-9 A-Z`, and the large weights are stored in float16 (cast back to float32 by the graph). On the
  sample plates it gives the same readings as the original model.
- **This file:** 4.58 MB, sha256 `bc1cfb349c5851ed73a51fe70e7fb8c069f73f981fd5298a007b1a2f5ebbb9f4`.
