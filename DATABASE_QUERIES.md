# Postgres Database Query Reference

This guide covers how to inspect and maintain your `careeragent` PostgreSQL database natively via Docker, or by connecting via an external GUI tool.

## 1. Running CLI Queries (via Docker)

You don't need to install any software on your server host to query the database. You can use the `psql` tool already built into the running Postgres container.

### Enter the Interactive Shell
To drop into an interactive SQL prompt:
```bash
docker exec -it $(docker compose ps -q postgres) psql -U careeragent -d careeragent
```
*Once inside, you can type standard SQL. Type `\q` to exit, `\dt` to list tables, and `\d tablename` to see a table's schema.*

### Run a Single Command
If you just want to run a quick command and see the output in your terminal:
```bash
docker exec -i $(docker compose ps -q postgres) psql -U careeragent -d careeragent -c "SELECT title, company FROM jobs ORDER BY created_at DESC LIMIT 5;"
```

## 2. Recommended Open Source GUI Tools (Debian / Linux)

If you prefer a graphical interface over the command line, here are the best open-source options for Debian to connect to your Postgres database:

1. **DBeaver (Community Edition)** - *Industry Standard*
   - The most powerful open-source database manager. It supports PostgreSQL perfectly. 
   - Install via apt/snap on Debian.
2. **Beekeeper Studio (Community Edition)** - *Most Beautiful/Modern*
   - A very clean, modern, electron-based SQL editor. Highly recommended if you want a simple and elegant UI.
3. **pgAdmin 4** - *The Official Postgres Tool*
   - A heavily featured, web-based (or desktop) UI built specifically for Postgres.

### Connecting your GUI Tool
To connect DBeaver or Beekeeper Studio to your database, you must first expose the Postgres port (5432) to your host network in `docker-compose.yml`. 

**Connection Details:**
* **Host**: `localhost` (or your server's local IP address, e.g., `192.168.1.50`)
* **Port**: `5432`
* **Database**: `careeragent`
* **Username**: `careeragent`
* **Password**: `secretpassword` (Change this in your .env!)
