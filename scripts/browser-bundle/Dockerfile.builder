FROM node:24.13.1-bookworm-slim AS node
FROM ubuntu:24.04
COPY --from=node /usr/local/ /usr/local/
RUN apt-get update && apt-get install -y --no-install-recommends build-essential python3 ca-certificates curl libcurl4-openssl-dev libssl-dev libexpat1-dev zlib1g-dev libgomp1 && rm -rf /var/lib/apt/lists/*
COPY source.tar /source.tar
RUN mkdir /source && tar -xf /source.tar -C /source && rm /source.tar
WORKDIR /source
ENV CI=1
ENTRYPOINT ["node", "scripts/build-browser-bundle.mjs", "/source", "/output"]
CMD ["0.0.0"]
