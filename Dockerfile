FROM node:24-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci
RUN npm install
COPY . .
ARG GIT_COMMIT_HASH
ENV GIT_COMMIT_HASH=${GIT_COMMIT_HASH}
RUN npm run build
EXPOSE 3000
CMD ["npm", "start"]
