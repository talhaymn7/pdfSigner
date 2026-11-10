# Browser test runner. Everything (Chromium, Playwright, helpers) stays inside this image.
FROM mcr.microsoft.com/playwright:v1.65.0-noble
WORKDIR /e2e
COPY package.json ./
RUN npm install --no-fund --no-audit
COPY . .
CMD ["npx", "playwright", "test"]
