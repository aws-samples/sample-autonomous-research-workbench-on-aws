# Ingest stage container (Docling + torch can't fit a zipped Lambda).
# Base is the AWS Lambda Python 3.12 runtime image.
#
# The two container checks below don't apply to Lambda images: Lambda has no
# health-check concept (the service manages the execution environment lifecycle
# and ignores HEALTHCHECK), and it already runs handler code as an unprivileged
# user in a per-invocation microVM, so a USER instruction changes nothing. Both
# are enforced on our ECS images (apps/api, apps/web, apps/worker), where they do
# have effect.
# checkov:skip=CKV_DOCKER_2: Lambda ignores HEALTHCHECK; lifecycle is service-managed
# checkov:skip=CKV_DOCKER_3: Lambda runs handlers unprivileged in its own sandbox
FROM public.ecr.aws/lambda/python:3.12

# NOTE: LibreOffice is intentionally NOT installed — it isn't in the AL2023
# repos and needs a bespoke prebuilt layer. It only powers the PPTX image-only
# VLM render fallback (soffice -> pdftoppm), which docling_ingest handles as
# best-effort: without soffice, render_pptx_slides() returns {} and ingestion
# proceeds on the text Docling found. PDF VLM rendering uses pypdfium2 (a pip
# wheel), so it still works. Docling text extraction and PPTX chart/notes
# recovery (python-pptx) are unaffected.

# CPU-only torch/torchvision first (avoids the multi-GB CUDA build Docling
# would otherwise pull), then the rest of the deps.
COPY requirements.txt ${LAMBDA_TASK_ROOT}/
RUN pip install --no-cache-dir \
        --extra-index-url https://download.pytorch.org/whl/cpu \
        -r ${LAMBDA_TASK_ROOT}/requirements.txt

# docling_ibm_models (tableformer) pulls opencv-python, whose GUI build needs
# X11 libs (libxcb.so.1, libGL.so.1, ...) absent from the Lambda base image.
# Swap it for the headless build — identical cv2 module, no X11 deps. Done
# atomically with --force-reinstall (so a stale dist-info can't leave us with
# no cv2 at all) and verified in the same layer so the BUILD fails here — in
# seconds, locally — rather than a deployed invocation 10 minutes later.
RUN pip uninstall -y opencv-python opencv-contrib-python \
        opencv-python-headless opencv-contrib-python-headless 2>/dev/null || true; \
    pip install --no-cache-dir --force-reinstall opencv-python-headless && \
    python -c "import cv2; print('cv2 OK', cv2.__version__)"

# Bake Docling's layout/table models into the image at an explicit path, and
# point the HuggingFace cache (HF_HOME) at a baked location too. At runtime the
# Lambda filesystem is read-only outside /tmp, so nothing may be fetched:
#  * download_models() -> DOCLING_ARTIFACTS, consumed via pdf_opts.artifacts_path
#    (set in build_converter()).
#  * HybridChunker() loads the sentence-transformers/all-MiniLM-L6-v2 tokenizer
#    via transformers/HF Hub — NOT covered by download_models — so pre-fetch it
#    into HF_HOME so the offline AutoTokenizer.from_pretrained resolves locally.
# HF_HOME is set BEFORE HF_HUB_OFFLINE so these two bakes can still reach the
# network; the offline flag then hard-blocks any stray runtime fetch. No
# `|| true` — a failed bake must fail the build, not defer to a read-only runtime.
ENV DOCLING_ARTIFACTS=/opt/docling-models
ENV HF_HOME=/opt/hf
# Tokenizer revision is pinned to an immutable commit (not a mutable branch) so
# the bake can't silently pull different weights. MUST match TOKENIZER_REVISION
# in handler.py — the offline cache lookup is revision-keyed.
ARG TOKENIZER_REVISION=1110a243fdf4706b3f48f1d95db1a4f5529b4d41
RUN python -c "from pathlib import Path; from docling.utils.model_downloader import download_models; download_models(output_dir=Path('${DOCLING_ARTIFACTS}'))"
RUN python -c "from transformers import AutoTokenizer; AutoTokenizer.from_pretrained('sentence-transformers/all-MiniLM-L6-v2', revision='${TOKENIZER_REVISION}')"
ENV HF_HUB_OFFLINE=1

# Handler + shared ingestion code.
COPY bedrock.py docling_ingest.py handler.py ${LAMBDA_TASK_ROOT}/

# Build-time smoke test: import the handler and fully initialize the Docling
# converter against the baked, offline models — the exact runtime import path
# (torch, cv2/tableformer, layout models). Any missing native lib or model
# fails the BUILD here, locally, instead of a deployed invocation. Runs offline
# (HF_HUB_OFFLINE=1 is already set) so it proves the container is self-contained.
RUN cd ${LAMBDA_TASK_ROOT} && SEMANTIC_BUCKET=build-smoke-test \
    python -c "import handler; handler._converter_and_chunker(); print('ingest image OK: converter+chunker initialized offline')"

CMD ["handler.handler"]
