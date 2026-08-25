# Semantic stage container (Docling-with-images + lancedb + torch can't fit a
# zipped Lambda). Base is the AWS Lambda Python 3.12 runtime image.
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

# NOTE: LibreOffice is intentionally NOT installed (not in AL2023 repos). It
# only powers the PPTX slide-render page images (soffice -> pdftoppm), handled
# best-effort: without it, render_pptx_slides() returns {} and PPTX page rows
# fall back to text-only. PDF page images (Docling) and figure crops still work.

# CPU-only torch/torchvision first, then the rest.
COPY requirements.txt ${LAMBDA_TASK_ROOT}/
RUN pip install --no-cache-dir \
        --extra-index-url https://download.pytorch.org/whl/cpu \
        -r ${LAMBDA_TASK_ROOT}/requirements.txt

# docling_ibm_models (tableformer) pulls opencv-python, whose GUI build needs
# X11 libs absent from the Lambda base image. Force the headless build and
# verify cv2 imports here so the BUILD fails locally, not at runtime.
RUN pip uninstall -y opencv-python opencv-contrib-python \
        opencv-python-headless opencv-contrib-python-headless 2>/dev/null || true; \
    pip install --no-cache-dir --force-reinstall opencv-python-headless && \
    python -c "import cv2; print('cv2 OK', cv2.__version__)"

# Bake Docling models + the chunker tokenizer so nothing is fetched at runtime
# (read-only fs outside /tmp). HF_HOME set before HF_HUB_OFFLINE so the bakes
# can still reach the network; the offline flag then hard-blocks stray fetches.
ENV DOCLING_ARTIFACTS=/opt/docling-models
ENV HF_HOME=/opt/hf
# Tokenizer revision is pinned to an immutable commit (not a mutable branch) so
# the bake can't silently pull different weights. MUST match TOKENIZER_REVISION
# in ingest.py — the offline cache lookup is revision-keyed.
ARG TOKENIZER_REVISION=1110a243fdf4706b3f48f1d95db1a4f5529b4d41
RUN python -c "from pathlib import Path; from docling.utils.model_downloader import download_models; download_models(output_dir=Path('${DOCLING_ARTIFACTS}'))"
RUN python -c "from transformers import AutoTokenizer; AutoTokenizer.from_pretrained('sentence-transformers/all-MiniLM-L6-v2', revision='${TOKENIZER_REVISION}')"
ENV HF_HUB_OFFLINE=1

# Handler + shared code.
COPY common.py ingest.py handler.py ${LAMBDA_TASK_ROOT}/

# Build-time smoke test: build the ingestor (Docling converter + Bedrock client)
# offline against the baked models — the exact runtime import path (torch, cv2,
# lancedb, layout models, tokenizer). Fails the BUILD here if anything's missing.
RUN cd ${LAMBDA_TASK_ROOT} && LANCEDB_URI=/tmp/lancedb-smoke KNOWLEDGE_BUCKET=build-smoke-test \
    python -c "import handler, ingest; ingest.build_ingestor(); print('semantic image OK: ingestor built offline')"

CMD ["handler.handler"]
