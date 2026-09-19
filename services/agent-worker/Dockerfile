FROM public.ecr.aws/lambda/nodejs:22 AS node-runtime

FROM node:22-bookworm-slim AS build
WORKDIR /src
COPY package.json package-lock.json ./
COPY packages ./packages
COPY services ./services
COPY apps/web/package.json ./apps/web/package.json
RUN npm ci --ignore-scripts
RUN npx esbuild services/agent-worker/src/lambda/session.ts --bundle --platform=node --target=node22 --format=cjs --outfile=/out/index.js --external:playwright-core

# Nova Act needs Python >= 3.10. Both Lambda base images use Amazon Linux 2023.
# Keep the Python runtime and install the Node Lambda runtime alongside it.
FROM public.ecr.aws/lambda/python:3.12
ARG NOVA_ACT_REQUIREMENT=nova-act==3.4.187.0
COPY --from=node-runtime /var/lang/bin/node /var/lang/bin/node
COPY --from=node-runtime /var/runtime /var/runtime
COPY services/agent-worker/python/requirements.txt /tmp/requirements.txt
RUN pip install --no-cache-dir "$NOVA_ACT_REQUIREMENT"
COPY --from=build /out/index.js ${LAMBDA_TASK_ROOT}/index.js
COPY --from=build /src/node_modules/playwright-core ${LAMBDA_TASK_ROOT}/node_modules/playwright-core
COPY services/agent-worker/python/nova_runner.py ${LAMBDA_TASK_ROOT}/nova_runner.py
ENV BETAVERSION_PYTHON=/var/lang/bin/python3.12
ENV BETAVERSION_NOVA_RUNNER=/var/task/nova_runner.py
CMD ["index.handler"]
