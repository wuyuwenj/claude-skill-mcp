# Specify the base Docker image
FROM apify/actor-node:22 AS builder

# Check preinstalled packages
RUN npm ls crawlee apify puppeteer playwright

# Copy just package.json and package-lock.json
# to speed up the build using Docker layer cache.
COPY --chown=myuser:myuser package*.json ./

# Install all dependencies. Don't audit to speed up the installation.
RUN npm install --include=dev --audit=false

# Next, copy the source files using the user set in the base image.
COPY --chown=myuser:myuser . ./

# Install all dependencies and build the project.
RUN npm run build

# Create final image
FROM apify/actor-node:22

# Check preinstalled packages
RUN npm ls crawlee apify puppeteer playwright

# Copy just package.json and package-lock.json
COPY --chown=myuser:myuser package*.json ./

# Install NPM packages, skip optional and development dependencies
RUN npm --quiet set progress=false \
    && npm install --omit=dev --omit=optional \
    && echo "Installed NPM packages:" \
    && (npm list --omit=dev --all || true) \
    && echo "Node.js version:" \
    && node --version \
    && echo "NPM version:" \
    && npm --version \
    && rm -r ~/.npm

# Copy built JS files from builder image
COPY --from=builder --chown=myuser:myuser /usr/src/app/dist ./dist

# Copy config files
COPY --chown=myuser:myuser configs ./configs

# Next, copy the remaining files and directories with the source code.
COPY --chown=myuser:myuser . ./

# Run the image.
CMD npm run start:prod --silent
