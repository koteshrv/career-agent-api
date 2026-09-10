# CareerAgent API

A centralized crowdsourcing API for the open-source CareerAgent job automation tool. This API serves as the global job-sharing network.

Built with **Node.js, Fastify, PostgreSQL, and Redis**.

It features an asymmetric (RS256) JWT-based SSO system (GitHub & Google) and a "Give-to-Get" credit economy to bypass global IP scraping bans by decentralizing the fetching across the community.

---

## 🚀 Production Deployment (Docker)

This API is fully containerized and designed to be deployed securely via Docker Compose.

### 1. Configure the Environment
1. Clone this repository to your server.
2. Copy the environment template:
   ```bash
   cp .env.example .env
   ```
3. Open `.env` and fill in your database passwords, RS256 JWT keys, and OAuth (GitHub/Google) client secrets.

### 2. Boot the Servers
Start the API, PostgreSQL, and Redis containers in the background. The API will automatically pull the latest pre-built image from the GitHub Container Registry.
```bash
docker compose pull
docker compose up -d
```

### 3. Initialize the Database
Once Postgres is running, you must import the database schema to create the tables.
```bash
cat schema.sql | docker exec -i $(docker compose ps -q postgres) psql -U careeragent -d careeragent
```
*(Warning: Running this command will drop and recreate all tables. Only run it once during initial setup).*

---

## 💻 Local Development

If you want to contribute to the API or test changes locally without Docker:

### 1. Install Dependencies
```bash
npm install
```

### 2. Set up local services
You will need a local PostgreSQL and Redis instance running. You can easily start these using the provided Docker compose file (just comment out the `api` service), or run them natively. Ensure your `.env` is updated with `localhost` URLs.

### 3. Run the development server
```bash
npm run dev
```
The server will start locally via `tsx` on port `3000`.

### 4. Run Tests
```bash
npm test
```

---

## 🔒 Security & Architecture Notes
* **Network Isolation**: The `docker-compose.yml` is configured with strict network separation. The API talks to Postgres and Redis over an isolated internal `db-network`.
* **Exposing the API**: The API binds to port `3000`. It is highly recommended to expose this to the internet via a reverse proxy (like Nginx, Caddy) or a Cloudflare Tunnel for SSL termination.
