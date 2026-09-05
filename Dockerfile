# The MCP server, in a container.
#
# Alexa+ reaches a self-hosted add-on over HTTPS, so the deployable artefact is
# the server and only the server: no simulator, no CLI, no corpora. The image
# runs `apps/mcp-server/src/main.ts` and listens on 8787.
#
# It has never been deployed. `docs/AWS.md` says why, and `infrastructure/cdk`
# is the stack that would run it.

FROM node:22-alpine AS deps
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@9.15.9 --activate
COPY package.json pnpm-lock.yaml ./
# `--prod` would drop tsx, which is how the server starts, so the dev tree is
# installed and the image is honest about being a source deployment rather than
# pretending to be a compiled one.
RUN pnpm install --frozen-lockfile

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    PORT=8787 \
    CIRCA_STORE=dynamodb
COPY --from=deps /app/node_modules ./node_modules
COPY package.json tsconfig.json ./
COPY packages ./packages
COPY apps/mcp-server ./apps/mcp-server
COPY apps/agent ./apps/agent
# The provider directory is data the server reads at runtime. It is thirty
# fictional businesses and it is labelled as such everywhere it surfaces.
COPY fixtures/providers ./fixtures/providers

# Not root. The server writes nothing to the filesystem when CIRCA_STORE is
# dynamodb, and this makes that a property of the container rather than a habit.
USER node

EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://localhost:8787/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "node_modules/tsx/dist/cli.mjs", "apps/mcp-server/src/main.ts"]
