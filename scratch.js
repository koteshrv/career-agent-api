import { sign } from 'hono/jwt';
import crypto from 'crypto';

globalThis.crypto = crypto;

const privateKey = `-----BEGIN PRIVATE KEY-----
MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQDE... (dummy)
-----END PRIVATE KEY-----`;

async function test() {
  try {
    await sign({ id: "123" }, privateKey, 'RS256');
    console.log("Success");
  } catch(e) {
    console.log(e.toString(), e.name, e.message);
  }
}
test();
