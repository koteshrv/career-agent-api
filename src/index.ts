import app from "./app";

/**
 * Process entry point: boots the app built in ./app.ts onto a real listening
 * socket. Kept separate from app.ts so tests can import the app itself and
 * drive it with app.inject() without ever binding a port. app.ts already
 * loads .env (quietly) as part of its own module evaluation, which happens
 * before any of this file's own code runs.
 */
const port = process.env.PORT ? parseInt(process.env.PORT) : 3000;
app.listen({ port, host: '0.0.0.0' }, (err, address) => {
  if (err) {
    app.log.error(err);
    process.exit(1);
  }
  console.log(`Server is running on ${address}`);
});
