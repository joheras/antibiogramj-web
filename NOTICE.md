# Third-party components and data

AntibiogramJ Web is released under the MIT License (see `LICENSE`). It includes or distributes the following
third-party components, each under its own licence:

| Component | Where | Licence |
|---|---|---|
| OpenCV.js 4.10 (`@techstark/opencv-js`) | browser build (Web Worker) | Apache License 2.0 |
| ONNX Runtime Web (`onnxruntime-web`) | browser build | MIT |
| ONNX Runtime (`onnxruntime`), OpenCV (`opencv-python-headless`) and the other Python packages in `backend/requirements.txt` | server version | their own licences (MIT, BSD, Apache-2.0) |
| PaddleOCR `ch_PP-OCRv3_rec` recogniser, ONNX export from RapidOCR, modified (`backend/seed/models/ppocr_rec.onnx`, see `backend/seed/models/README.md`) | OCR of the disk codes | Apache License 2.0 |
| React, React Router, UTIF.js, pako | browser build | MIT (pako: MIT and Zlib) |

The Apache License 2.0 is available at https://www.apache.org/licenses/LICENSE-2.0. The modified OCR model is a
derivative of PaddleOCR/RapidOCR: the changes are described in `backend/seed/models/README.md` and made by
`backend/scripts/build_ocr_model.py`.

## Data

* **Disk-code templates** (`backend/seed/templates/`) and the AntibiogramJXML format come from the AntibiogramJ
  desktop application (University of La Rioja).
* **EUCAST breakpoint tables** (`backend/seed/standards/EUCAST-*.xml`) and **EUCAST QC tables**
  (`backend/seed/qc/`) are transcriptions of documents of the European Committee on Antimicrobial Susceptibility
  Testing (https://www.eucast.org). They are reproduced for convenience; the official EUCAST documents prevail.
* **CLSI** (`backend/seed/standards/CLSI-2015.xml`) is a minimal example inherited from the desktop application.
  CLSI documents (M100) are copyrighted by the Clinical and Laboratory Standards Institute and are not
  reproduced here.

AntibiogramJ Web is a research and teaching tool. It is not a certified medical device; every result must be
checked by qualified personnel.
