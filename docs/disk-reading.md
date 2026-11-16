# Lectura de los discos sin plantillas

Estudio de alternativas al *template matching* (ORB + plantillas por antibiótico) para identificar el antibiótico
de cada disco. Prototipos y datos: [`research/disk_reading/`](../research/disk_reading/README.md).

## Resumen y recomendación

**Recomendación: OCR del código impreso con el reconocedor de texto de PP-OCR (PaddleOCR exportado a ONNX) y
decodificación restringida al léxico de códigos (CTC), con la confianza como criterio para aceptar
automáticamente o pedir confirmación. Las plantillas se mantienen solo como respaldo y para aprender de las
correcciones del usuario.**

- Con 28 discos distintos (66 fotos de disco), sin ninguna plantilla: **23/28 aciertos (82 %)**, frente a 20/28 de
  las plantillas actuales (que, además, seguramente se hicieron con estas mismas imágenes) y 20/28 de Tesseract.
- La confianza está bien calibrada: con `logp ≥ −2` se aceptan automáticamente 47 de 66 discos (19 de 28 distintos)
  y **todos son correctos**. Los demás se enseñan al usuario con 3 sugerencias, y la correcta está entre ellas en
  26 de 28.
- Si se combina con las plantillas como respaldo (PP-OCR cuando `logp ≥ −2`, si no, plantillas): 27/28 (65/66). Es
  una cifra optimista, porque las plantillas salen de estas mismas imágenes.
- Cualquier antibiótico nuevo, o cualquier código de otro fabricante (BD "AN" en vez de Oxoid "AK"), se añade con
  una línea en una tabla de sinónimos. No hacen falta imágenes.
- Funciona igual en el servidor (onnxruntime) y en el navegador (onnxruntime-web en el *worker*, con el modelo
  servido desde el propio sitio). En el navegador nada sale del ordenador.
- Coste: un modelo de 10,7 MB (fp32; ~3 MB cuantizado a int8), y ~0,5 s por disco en la CPU del servidor. En WASM
  se esperan ~1–2 s por disco, a medir.

## Opciones comparadas

| Opción | Precisión (aquí) | Rotación | Tamaño / velocidad | Licencia | Esfuerzo | Valoración |
|---|---|---|---|---|---|---|
| **Plantillas ORB (actual)** | 20/28 (71 %), sesgada al alza | invariante (ORB) | <1 MB · 15 ms/disco | — | hecho | Solo reconoce 18 antibióticos y depende del fabricante y la iluminación |
| **(a) Tesseract 5 / Tesseract.js** + rotaciones + léxico difuso | 20/28 (71 %) | no: hay que probar 24 rotaciones | wasm ~3–4 MB + `eng` 4–15 MB · 1,1–1,3 s/disco (CLI, 24 rotaciones) | Apache-2.0 | bajo | Falla con texto borroso o tenue. Es un motor de documentos, poco adecuado para 2–3 caracteres sueltos |
| **(a′) PP-OCR *rec* (ONNX) + CTC con léxico** ⭐ | **23/28 (82 %)**, top-3 26/28 | no: se prueban 18+2 ángulos, la propia red hace de juez | 10,7 MB (int8 ≈3 MB) + onnxruntime-web ~10 MB · 0,46 s/disco (CPU, 4 hilos) | Apache-2.0 (modelos) / MIT (onnxruntime) | medio | La mejor relación precisión/esfuerzo, con confianza calibrada y sin datos de entrenamiento |
| (b) CNN/CRNN propia entrenada con discos sintéticos (códigos renderizados con fuentes tipo Helvetica, rotación, desenfoque, manchas) | sin medir. Esperable ≥ PP-OCR si los sintéticos se parecen a los reales | se entrena para ser invariante, o se combina con el barrido de ángulos | <1 MB (37 clases) · ms | propia | alto (generador, entrenamiento con PyTorch, validación con discos reales) | Buen paso 2 si PP-OCR se queda corto. Hace falta un conjunto de validación real, que ahora no hay |
| (c) Detección + reconocimiento genéricos (PP-OCR det+rec, EasyOCR, docTR) | det+rec de RapidOCR (24 rotaciones), probado parcialmente: 6/10 en los primeros discos y varios segundos por disco | el clasificador de ángulo solo cubre 0/180° | det 2,4 MB + rec 10,7 MB (EasyOCR/docTR: 20–100 MB) | Apache-2.0 | medio | No compensa: el disco solo tiene el código y la geometría se resuelve con OpenCV. El detector añade coste y errores |
| (d) Modelos visión-lenguaje (VLM) | sin medir | buena | remotos (GPT-4o, Claude, Gemini): **rompen "nada sale del navegador"**. Locales (Florence-2 0,23 B, SmolVLM 256M, Moondream): 0,3–2 GB, WebGPU, segundos por disco | variable (MIT/Apache en los locales) | bajo de integrar, alto de controlar | Solo como opción opcional del servidor. Son pesados, no deterministas y difíciles de calibrar |
| (e) "Renderizar y comparar": códigos dibujados con fuentes Hershey y comparados por distancia *chamfer* | 8/28 (29 %) | barrido de 72 ángulos | 0 MB · 0,9 s | — | bajo | **Descartado**: la forma global con otra fuente no distingue bien códigos parecidos |

## Datos y protocolo

- Placas de ejemplo de la aplicación de escritorio (`images/0…10.tiff`, sin la 6) procesadas con el mismo
  *pipeline* de la web (`detect_plate` → recorte → `enhance_contrast` → `detect_disks` → `disk_crop`). Se detectan
  todos los discos: 66 en total.
- Las placas 0, 4, 5, 7, 8 y 9 son fotos de **la misma placa**, y la 2 y la 10 también. Hay 4 placas distintas
  (0, 1, 2 y 3) con **28 discos distintos**, y esa es la cifra que cuenta. Las 66 fotos se dan como referencia de
  estabilidad.
- La verdad de referencia está en `ground_truth.json`, leída a ojo de los recortes. Hay discos con contenido CLSI
  (`CTX 30`, `CAZ 30`, `AMC 30`, `P 10`) que no coincide con el del catálogo EUCAST (`CTX 5`, `CAZ 10`…), así que
  se evalúa **el antibiótico** (nombre). El contenido impreso solo se usa como evidencia adicional.
- Los recortes de `antibiotics/<id>/` de la app de escritorio **no sirven para OCR**: son la salida de
  `keepOnlyLetters` (envolventes convexas rellenas de cada letra, ilegibles). Son las mismas plantillas que usa la
  web (`backend/seed/templates`). Como seguramente salen de estas mismas fotos, el 71 % de las plantillas es una
  cota optimista.
- La placa 3 está muy desenfocada. Es el peor caso para todos los métodos.

## Resultados por disco (28 discos distintos)

| disco | impreso | PP-OCR + léxico | plantillas | Tesseract |
|---|---|---|---|---|
| 0/0 | AK 30 | ❌ C 30 | ✅ | ✅ AK 30 |
| 0/1 | CN 10 | ✅ CN 10 | ✅ | ✅ CN 10 |
| 0/2 | SXT 25 | ✅ SXT 25 | ✅ | ✅ SXT 25 |
| 0/3 | NA 30 | ✅ NA 30 | ✅ | ✅ NA 30 |
| 0/4 | TOB 10 | ✅ TOB 10 | ✅ | ✅ TOB 10 |
| 0/5 | CIP 5 | ✅ CIP 5 | ✅ | ✅ CIP 5 |
| 1/0 | TE 30 | ✅ TE 30 | ✅ | ✅ TE 30 |
| 1/1 | CTX 30 | ✅ CTX 30 | ✅ | ✅ CTX 30 |
| 1/2 | FOX 30 | ✅ FOX 30 | ✅ | ✅ FOX 30 |
| 1/3 | AMC 30 | ✅ AMC 30 | ✅ | ❌ AK 30 |
| 1/4 | C 30 (muy tenue) | ❌ P 10 | ✅ | ❌ F 100 |
| 1/5 | CAZ 30 | ✅ CAZ 30 | ✅ | ✅ CAZ 10 |
| 1/6 | AMP 10 | ✅ AMP 10 | ✅ | ✅ AMP 10 |
| 2/0 | TOB 10 | ✅ TOB 10 | ✅ | ✅ TOB 10 |
| 2/1 | CN 10 | ✅ CN 10 | ✅ | ✅ CN 10 |
| 2/2 | TE 30 | ✅ TE 30 | ✅ | ✅ TE 30 |
| 2/3 | CIP 5 | ✅ CIP 5 | ❌ TOB | ✅ CIP 5 |
| 2/4 | P 10 (rojo) | ✅ P 10 | ❌ ninguno | ✅ P 10 |
| 2/5 | FOX 30 (rojo) | ✅ FOX 30 | ❌ TOB | ✅ FOX 30 |
| 2/6 | DA 2 | ✅ DA 2 | ❌ FOX | ✅ DA 2 |
| 2/7 | SXT 25 | ✅ SXT 25 | ✅ | ✅ SXT 25 |
| 3/0 | CN 10 (borroso) | ❌ W 5 | ❌ AK | ❌ CC 2 |
| 3/1 | TOB 10 (borroso) | ❌ P 10 | ✅ | ❌ P 1 |
| 3/2 | NA 30 (borroso) | ❌ C 30 | ✅ | ❌ RA 5 |
| 3/3 | SXT 25 (borroso) | ✅ SXT 25 | ❌ CAZ | ❌ AM 2 |
| 3/4 | CIP 5 (borroso) | ✅ CIP 5 | ❌ AK | ❌ C 30 |
| 3/5 | TE 30 (borroso) | ✅ TE 30 | ✅ | ✅ TE 30 |
| 3/6 | C 30 (borroso) | ✅ C 30 | ❌ TOB | ❌ AN 30 |

| método | 28 distintos | 66 fotos | tiempo/disco |
|---|---|---|---|
| plantillas (actual) | 20 (71 %) | 54 (82 %) | 15–18 ms |
| Tesseract + rotaciones + léxico difuso | 20 (71 %) | 57 (86 %) | 1,1–1,3 s |
| renderizar y comparar (Hershey + chamfer) | 8 (29 %) | 16 (24 %) | 0,9 s |
| **PP-OCR rec + CTC con léxico** | **23 (82 %)** | **56 (85 %)** | 0,46 s |
| PP-OCR, correcto entre las 3 primeras sugerencias | 26 (93 %) | 59 (89 %) | |
| PP-OCR si `logp ≥ −2`, si no plantillas | 27 (96 %)* | 65 (98 %)* | |

\* Optimista, porque las plantillas proceden probablemente de estas imágenes.

**Calibración de PP-OCR** (66 fotos): con `logp ≥ −1` se aceptan 39 y todas son correctas. Con `≥ −2`, 47 y todas
correctas. Con `≥ −3`, 55, de las que 54 son correctas. En los 28 distintos, con `≥ −2` se aceptan 19 y todas son
correctas. Los fallos tienen siempre una confianza baja: el sistema "sabe que no sabe".

Los errores restantes son la impresión emborronada de "AK", un "C 30" casi invisible y tres discos desenfocados de
la placa 3. En ellos falla la geometría (orientación y separación de líneas) más que el reconocedor. Cuando la
orientación es correcta, la red lee el código con `logp ≈ 0`.

## Cómo funciona el lector recomendado (`ppocr.py`)

1. **Normalización**: mínimo de los canales G y B (así la tinta roja queda igual de oscura que la negra),
   corrección de fondo (cierre morfológico de 41 px) y umbral robusto `mediana − 3·MAD` dentro del disco. El umbral
   Otsu perdía letras tenues y convertía en "tinta" la textura de los discos pálidos.
2. **Máscara de texto**: se eliminan las motas, la barra de orientación (el componente alargado) y los componentes
   lejos del centro. El número de componentes da una estimación del número de caracteres, que se usa como
   *prior* de longitud.
3. **Barrido de ángulos**: cada 20°, y después ±7° alrededor del mejor (20 orientaciones). En cada una se recorta
   el bloque de texto y se prueban dos disposiciones: una línea, o dos líneas cortadas por el valle del perfil
   horizontal.
4. **Reconocimiento**: el reconocedor PP-OCRv3 (entrada de 48 px de alto) da las probabilidades CTC de cada
   línea. Se restringen a `A–Z 0–9`.
5. **Decodificación con léxico**: con el algoritmo *forward* de CTC (vectorizado para todos los códigos a la vez)
   se calcula `log P(código | imagen)` de cada entrada del léxico (abreviatura + contenido impreso, en orden de
   lectura). A eso se le resta la verosimilitud de la lectura libre de esa misma orientación (razón de
   verosimilitudes) y se suma el *prior* de longitud. Gana la mejor pareja (orientación, código). Esta puntuación
   es la confianza `logp`, que vale 0 cuando la lectura es perfecta.

El **léxico** (`codes.py`) sale del catálogo (`code` = abreviatura + contenido) más una tabla de sinónimos por
antibiótico, con códigos de otros fabricantes (BD: `AN`, `GM`, `AM`, `CC`, `NN`, `LVX`, `RA`, `F/M`…) y
contenidos impresos alternativos (CLSI: `CTX 30`, `CAZ 30`, `AMC 30`, `P 10`…). Los contenidos compuestos se
imprimen como suma (`20-10` → `30`, `1.25-23.75` → `25`). **Los sinónimos de la tabla están escritos de memoria y
hay que verificarlos** con los catálogos de Oxoid/Thermo, BD BBL, Liofilchem, Bio-Rad, Mast, Rosco e HiMedia.

## Integración en AntibiogramJ Web

**Módulo común.** El mismo algoritmo se implementa dos veces, como ya pasa con `matching.py` y `cv.ts`:

- **Servidor**: `backend/app/cv/reading.py` (onnxruntime + OpenCV + numpy; se añade la dependencia `onnxruntime`,
  una rueda de ~15 MB). El modelo va en `backend/seed/models/ppocr_rec.onnx`, y el endpoint de reconocimiento
  devuelve `{antibiotic_id, code_read, confidence, candidates[3]}`.
- **Navegador**: el *worker* carga `onnxruntime-web` (WASM con SIMD; WebGPU opcional) y el modelo desde
  `public-browser/models/` (mismo origen y cacheado: nada sale del ordenador). El preprocesado se hace con
  OpenCV.js, y la decodificación CTC son ~60 líneas de TypeScript. El modelo se descarga una sola vez y se carga
  bajo demanda, solo cuando se lee el primer disco.
- **Tabla de códigos**: un fichero de datos `codes.json` (antibiótico → abreviaturas por fabricante + contenidos
  impresos), compartido por ambas versiones y generado junto a `catalog.json`. Además, cada usuario puede tener sus
  propios códigos: en la BD en el servidor y en IndexedDB en el navegador. Así se cubre una marca local sin tocar
  código.

**Flujo de decisión** para cada disco:

1. Se ejecuta PP-OCR con el léxico. Si `confidence ≥ −2`, se asigna el antibiótico automáticamente.
2. Si no, se comprueba si las plantillas (compartidas o aprendidas) dan un resultado que coincide con uno de los
   3 candidatos del OCR, o con mucha puntuación. En ese caso se asigna, marcado como "a revisar".
3. Si no, se muestran al usuario los 3 candidatos (aciertan en el 93 % de los casos) más la lista completa para
   elegir a mano. Esto ya existe en la interfaz.

**Aprender de las correcciones del usuario:**

- Se guarda el recorte como plantilla aprendida (como ahora), y sigue siendo útil como respaldo para ese
  laboratorio.
- Si el OCR leyó con confianza un texto que no está en el léxico (p. ej. `AMK 30`) y el usuario elige Amikacina, se
  propone añadir `AMK` como sinónimo de usuario. Desde entonces se reconoce sin plantillas.
- Opcional y con consentimiento explícito: exportar recortes y etiquetas para crear un conjunto de validación real,
  que es lo que falta para la opción (b). En la versión del navegador, solo si el usuario lo descarga él mismo.

## Plan de implementación

1. **Verificar la tabla de sinónimos** con los catálogos de los fabricantes y convertirla en `codes.json`, con
   pruebas que comprueben que cada antibiótico del catálogo tiene al menos un código.
2. **Elegir el modelo**: comparar `ch_PP-OCRv3_rec` (el probado, 10,7 MB) con `en_PP-OCRv4_rec` (alfabeto latino,
   más pequeño) y con versiones cuantizadas a int8. Fijar la versión y la suma de comprobación en el repositorio.
3. **Backend**: portar `ppocr.py` a `app/cv/reading.py` con su API limpia y pruebas sobre `tests/images/1.tiff`
   (hoy da 6/7; falla el `C 30` casi invisible). Hay que cambiar el endpoint para devolver confianza y candidatos, y mantener las plantillas
   como respaldo.
4. **Frontend**: mostrar la confianza y los 3 candidatos en la tabla de discos y marcar "a revisar" lo que no
   supere el umbral.
5. **Versión navegador**: añadir `onnxruntime-web` al *worker*, portar el preprocesado (OpenCV.js) y la CTC a
   TypeScript, servir el modelo desde `public-browser/models/` y comprobar que da los mismos resultados que Python
   con los mismos recortes. Medir el tiempo en WASM y, si hace falta, reducir el barrido de ángulos (paso de 30°,
   parar en cuanto `logp > −0,5`) o usar WebGPU.
6. **Sinónimos de usuario y aprendizaje** a partir de las correcciones (servidor y IndexedDB).
7. **Validación** con más placas: otros fabricantes (BD, Liofilchem), otra iluminación y fotos de móvil. Ajustar el
   umbral de confianza con esos datos.
8. Si en esa validación PP-OCR falla con algún fabricante o fuente: **opción (b)**, ajustar o entrenar un CRNN
   pequeño con discos sintéticos y los recortes reales recogidos en el paso 6.

## Limitaciones

- La muestra es pequeña: 28 discos distintos, de un solo laboratorio y casi todos con la tipografía de Oxoid. Las
  cifras indican una tendencia, no una precisión final.
- El barrido de 20 orientaciones domina el tiempo. Se puede reducir con una estimación previa de la orientación
  (la barra impresa bajo el código la indica) en cuanto haya más datos para validarla.
- Los códigos de una sola letra (`C`, `E`, `F`, `P`, `S`, `W`) son los más frágiles. El contenido impreso y el
  *prior* de longitud ayudan, pero son los candidatos naturales a confirmación manual.
