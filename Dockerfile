FROM node:20-alpine

# XLSX support (security-first): convert XLSX -> CSV in the worker using Python + openpyxl.
RUN apk add --no-cache python3 py3-openpyxl

WORKDIR /app

COPY package*.json ./
RUN npm install

RUN chmod +x node_modules/.bin/*

COPY . .

# Default container entrypoint runs the API server.
# Railway worker service should override the start command to `npm run worker`.
CMD ["npm", "run", "start"]
