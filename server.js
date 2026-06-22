'use strict';

const express = require('express');
const config = require('./config');
const logger = require('./logger');
const auth = require('./auth-service');
const sync = require('./sync-service');

const app = express();
app.use(express.json());

app.get('/health', (req, res) => {
  res.json({ status: 'ok', uptime: process.uptime(), timestamp: new Date().toISOString() });
});

app.post('/auth/configure', (req, res) => {
  try {
    res.json({ ok: true, config: auth.configure(req.body || {}) });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

app.post('/auth/test', async (req, res) => {
  try {
    res.json({ ok: true, result: await auth.test() });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.post('/sync/start', async (req, res) => {
  try {
    res.json({ ok: true, status: await sync.start() });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.post('/sync/stop', (req, res) => {
  res.json({ ok: true, status: sync.stop() });
});

app.get('/sync/status', (req, res) => {
  res.json({ ok: true, status: sync.status() });
});

app.use((req, res) => res.status(404).json({ ok: false, error: 'not found' }));

const server = app.listen(config.port, () => {
  logger.info('HevyGarmin listening on port %d', config.port);
});

function shutdown(signal) {
  logger.info('%s received, shutting down', signal);
  sync.stop();
  server.close(() => process.exit(0));
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

module.exports = app;
