FROM denoland/deno:alpine-2.9.7

# Picks up any Alpine security patches published after this base image was
# built, without waiting for denoland to re-push the alpine-2.9.7 tag.
RUN apk upgrade --no-cache

WORKDIR /app

COPY deno.json ./
RUN deno install

COPY index.ts ./

USER deno

EXPOSE 8000

CMD ["deno", "run", "--allow-net", "--allow-env", "--allow-read", "index.ts"]
