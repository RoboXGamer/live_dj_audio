// Vite terminates HTTPS; its proxy reaches this server on the local machine.
delete process.env.TLS_CERT;
delete process.env.TLS_KEY;
process.env.PORT = '3000';
process.env.HOST = '127.0.0.1';
await import('./index.mjs');
