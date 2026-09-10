import re

with open('src/index.ts', 'r') as f:
    code = f.readlines()

out = []
in_route = False

for line in code:
    # Imports
    if "import { Hono }" in line:
        out.append("import Fastify, { FastifyRequest, FastifyReply } from 'fastify';\n")
        out.append("import jwt from 'jsonwebtoken';\n")
        continue
    if "import type { MiddlewareHandler" in line:
        continue
    if "import { sign, verify } from 'hono/jwt'" in line:
        continue
    if "import { cors } from 'hono/cors'" in line:
        out.append("import cors from '@fastify/cors';\n")
        continue
    if "import { logger } from 'hono/logger'" in line:
        continue
    if "import { serve } from \"@hono/node-server\"" in line:
        continue

    # App init
    if "const app = new Hono" in line:
        out.append("const app = Fastify({ logger: true });\n")
        out.append("declare module 'fastify' {\n  interface FastifyRequest {\n    user?: { id: string; email: string; };\n  }\n}\n")
        continue
    if "app.use('*', logger())" in line:
        continue

    # CORS
    if "app.use('*', cors({" in line:
        out.append("app.register(cors, {\n")
        continue
    if "origin: (origin, c) => {" in line:
        out.append("  origin: (origin, cb) => {\n")
        continue
    if "return origin && allowed.includes(origin) ? origin : allowed[0];" in line:
        out.append("    if (!origin || allowed.includes(origin)) { cb(null, true); } else { cb(null, allowed[0]); }\n")
        continue
    
    # Rate Limiting
    if "app.use('*', async (c, next) => {" in line:
        out.append("app.addHook('onRequest', async (request, reply) => {\n")
        continue
    if "const ip = c.req.header('cf-connecting-ip') || c.req.header('x-forwarded-for') || 'unknown';" in line:
        out.append("  const ip = (request.headers['cf-connecting-ip'] || request.headers['x-forwarded-for'] || request.ip || 'unknown') as string;\n")
        continue
    if "return c.json({ error: 'Too Many Requests' }, 429);" in line:
        out.append("      return reply.status(429).send({ error: 'Too Many Requests' });\n")
        continue
    if "await next();" in line:
        continue

    # Auth Middleware
    if "const authMiddleware: MiddlewareHandler" in line:
        out.append("const authMiddleware = async (request: FastifyRequest, reply: FastifyReply) => {\n")
        continue
    if "const authHeader = c.req.header('Authorization');" in line:
        out.append("  const authHeader = request.headers.authorization;\n")
        continue
    if "return c.json({ error: 'Unauthorized' }, 401);" in line:
        out.append("    return reply.status(401).send({ error: 'Unauthorized' });\n")
        continue
    if "payload = await verify(token, process.env.PUBLIC_KEY!, 'RS256');" in line:
        out.append("    payload = jwt.verify(token, process.env.PUBLIC_KEY!, { algorithms: ['RS256'] }) as any;\n")
        continue
    if "return c.json({ error: 'Forbidden' }, 403);" in line:
        out.append("      return reply.status(403).send({ error: 'Forbidden' });\n")
        continue
    if "c.set('user', { id: user.id, email: user.email });" in line:
        out.append("    request.user = { id: user.id, email: user.email };\n")
        continue
    if "return c.json({ error: 'Invalid or expired token' }, 401);" in line:
        out.append("    return reply.status(401).send({ error: 'Invalid or expired token' });\n")
        continue

    # Routes
    line = re.sub(r'app\.post\(\'([^\']+)\', async \(c\) => \{', r"app.post('\1', async (request, reply) => {", line)
    line = re.sub(r'app\.get\(\'([^\']+)\', async \(c\) => \{', r"app.get('\1', async (request, reply) => {", line)
    
    # Add preHandler for protected routes
    if "app.post('/api/jobs/push'" in line or "app.post('/api/jobs/report'" in line or "app.get('/api/jobs/pull'" in line or "app.get('/api/me'" in line:
        line = line.replace('async (request, reply)', '{ preHandler: authMiddleware }, async (request, reply)')

    # Route body/query
    line = re.sub(r'const user = c\.get\(\'user\'\);', r"const user = request.user!;", line)
    line = re.sub(r'c\.req\.json\(\)', r"Promise.resolve(request.body)", line)
    line = re.sub(r'c\.req\.query\(\'([^\']+)\'\)', r"(request.query as any)._1_", line).replace("_1_", r"\1")
    line = re.sub(r'return c\.json\(([^,]+), ([0-9]{3})\);', r"return reply.status(\2).send(\1);", line)
    line = re.sub(r'return c\.json\(([^,]+)\);', r"return reply.send(\1);", line)
    line = re.sub(r'return c\.json\(([\s\S]+?), ([0-9]{3})\);', r"return reply.status(\2).send(\1);", line) # Multiline might not work purely like this

    # JWT Sign
    if "const token = await sign(payload, process.env.PRIVATE_KEY!, 'RS256');" in line:
        line = line.replace("await sign(payload, process.env.PRIVATE_KEY!, 'RS256')", "jwt.sign(payload, process.env.PRIVATE_KEY!, { algorithm: 'RS256' })")

    # Error Handler
    if "app.onError((err, c) => {" in line:
        out.append("app.setErrorHandler((error, request, reply) => {\n")
        out.append("  request.log.error(error);\n")
        out.append("  return reply.status(500).send({ error: 'Internal server error', requestId: request.id });\n")
        out.append("});\n")
        # Skip the original body
        continue
    if "console.error(err);" in line or "return c.json({ error: 'Internal server error' }, 500);" in line:
        continue

    # Start
    if "serve({ fetch: app.fetch, port });" in line:
        out.append("app.listen({ port, host: '0.0.0.0' }, (err, address) => {\n")
        out.append("  if (err) {\n")
        out.append("    app.log.error(err);\n")
        out.append("    process.exit(1);\n")
        out.append("  }\n")
        out.append("});\n")
        continue
    if "console.log(`Server is running on port ${port}`);" in line:
        continue
        
    out.append(line)

# Let's fix multiline c.json returns which are heavily used
full_text = "".join(out)
full_text = re.sub(r'return c\.json\(\s*(\{[\s\S]*?\})\s*,\s*([0-9]{3})\s*\);', r"return reply.status(\2).send(\1);", full_text)
full_text = re.sub(r'return c\.json\(\s*(\{[\s\S]*?\})\s*\);', r"return reply.send(\1);", full_text)


with open('src/index.ts.new', 'w') as f:
    f.write(full_text)
