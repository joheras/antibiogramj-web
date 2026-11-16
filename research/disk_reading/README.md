# Disk reading without templates — prototypes

Research code behind [docs/disk-reading.md](../../docs/disk-reading.md). Not used by the app.

| file | what |
|---|---|
| `extract.py` | plate → disk crops with the app's own pipeline (`detect_plate`, `enhance_contrast`, `detect_disks`) |
| `ground_truth.json` | text printed on each disk of the desktop app's sample plates (read by eye) |
| `codes.py` | lexicon: catalogue codes + manufacturer synonyms + printed contents; confusion-aware fuzzy matching |
| `ocr.py` | preprocessing + rotations + Tesseract (CLI) + fuzzy lexicon matching |
| `render_match.py` | codes rendered with Hershey fonts compared by chamfer distance (negative result) |
| `ppocr.py` | **PP-OCR recogniser (ONNX) + lexicon-constrained CTC** — the recommended approach |
| `rapid.py` | full RapidOCR det+rec pipeline as an `ocr.py` engine (too slow, not reported) |
| `evaluate.py` | runs readers on the sample plates, writes `results/<engines>.json` |
| `analyze.py` | per-disk table, confidence thresholds, top-3, ensembles |

## Running

```bash
python3 -m venv /tmp/ocrvenv
/tmp/ocrvenv/bin/pip install rapidocr_onnxruntime==1.2.3 opencv-python-headless==4.10.0.84 numpy==2.2.1
/tmp/ocrvenv/bin/pip uninstall -y opencv-python   # pulled in by rapidocr; keep the backend's OpenCV
cd research/disk_reading
/tmp/ocrvenv/bin/python evaluate.py <antibiogramj-code>/images templates tesseract ppocr
/tmp/ocrvenv/bin/python analyze.py results/templates_tesseract_ppocr.json
```

`tesseract` (5.x, `eng`) must be on the PATH for the Tesseract reader. The PP-OCR recogniser used is
`ch_PP-OCRv3_rec_infer.onnx` (10.7 MB) shipped inside `rapidocr_onnxruntime`.
