FROM public.ecr.aws/lambda/python:3.12

# Install build tools for potential C extensions
RUN dnf install -y gcc git && dnf clean all

# Copy and install Python deps
COPY requirements.txt /tmp/requirements.txt
RUN pip install --no-cache-dir -r /tmp/requirements.txt beautifulsoup4==4.13.3

# Copy source into Lambda task root
COPY worker.py ${LAMBDA_TASK_ROOT}/worker.py
COPY lambda_handler.py ${LAMBDA_TASK_ROOT}/lambda_handler.py

# Lambda entry point
CMD ["lambda_handler.handler"]
