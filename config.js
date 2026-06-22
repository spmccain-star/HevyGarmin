'use strict';

require('dotenv').config();

const config = {
  port: parseInt(process.env.PORT || '3000', 10),
  logLevel: process.env.LOG_LEVEL || 'info',
  pollIntervalMs: parseInt(process.env.POLL_INTERVAL_MS || '5000', 10),
  garmin: {
    email: process.env.GARMIN_EMAIL || '',
    password: process.env.GARMIN_PASSWORD || '',
  },
  hevy: {
    apiKey: process.env.HEVY_API_KEY || '',
    apiBase: process.env.HEVY_API_BASE || 'https://api.hevyapp.com/v1',
  },
};

module.exports = config;
