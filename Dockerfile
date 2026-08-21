FROM node:20-alpine
RUN apk add --no-cache openssl

EXPOSE 3000

WORKDIR /app

ENV NODE_ENV=production

COPY package.json package-lock.json* ./

# --ignore-scripts is load-bearing, not a shortcut.
#
# `@react-router/dev` is a production dependency (the image builds the app, so
# it has to be), which means `--omit=dev` still pulls vite -> tsx -> tsx's own
# nested esbuild 0.28.2, alongside vite's hoisted esbuild 0.25.12. esbuild's
# postinstall validates its binary by executing whatever `esbuild` resolves to,
# finds the hoisted 0.25.12 from the nested 0.28.2's script, and aborts the
# entire install with `Expected "0.28.2" but got "0.25.12"`.
#
# The binaries themselves are ordinary optional-dependency packages — one
# correctly versioned @esbuild/linux-x64 sits beside each esbuild — so npm
# places them either way and only the validation is skipped.
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

COPY . .

# @prisma/client generates itself from a postinstall script, which the flag
# above also skips. The build imports the client, so this has to run here and
# not only in `npm run setup` at start-up.
RUN npx prisma generate

RUN npm run build

CMD ["npm", "run", "docker-start"]
