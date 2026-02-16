FROM node:20-alpine

WORKDIR /app

COPY package*.json ./
RUN npm install

RUN chmod +x node_modules/.bin/*

COPY . .

# Default container entrypoint runs the API server.
# Railway worker service should override the start command to `npm run worker`.
CMD ["npm", "run", "start"]
