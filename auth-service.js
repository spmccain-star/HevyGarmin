'use strict';

const config = require('./config');
const logger = require('./logger');
const GarminClient = require('./garmin-client');
const HevyClient = require('./hevy-client');

// Holds credential state and hands out lazily-constructed API clients.
// Credentials default to the environment (config) and can be overridden at
// runtime via POST /auth/configure.
class AuthService {
  constructor() {
    this.garminEmail = config.garmin.email;
    this.garminPassword = config.garmin.password;
    this.hevyApiKey = config.hevy.apiKey;
    this.hevyApiBase = config.hevy.apiBase;
    this.garmin = null;
    this.hevy = null;
  }

  configure({ garminEmail, garminPassword, hevyApiKey } = {}) {
    if (garminEmail) this.garminEmail = garminEmail;
    if (garminPassword) this.garminPassword = garminPassword;
    if (hevyApiKey) this.hevyApiKey = hevyApiKey;
    // Force clients to be rebuilt with the new credentials.
    this.garmin = null;
    this.hevy = null;
    logger.info('Credentials reconfigured');
    return this.summary();
  }

  summary() {
    return {
      garminEmail: this.garminEmail || null,
      garminConfigured: Boolean(this.garminEmail && this.garminPassword),
      hevyConfigured: Boolean(this.hevyApiKey),
    };
  }

  getGarmin() {
    if (!this.garminEmail || !this.garminPassword) throw new Error('Garmin credentials not configured');
    if (!this.garmin) this.garmin = new GarminClient(this.garminEmail, this.garminPassword);
    return this.garmin;
  }

  getHevy() {
    if (!this.hevyApiKey) throw new Error('Hevy API key not configured');
    if (!this.hevy) this.hevy = new HevyClient(this.hevyApiKey, this.hevyApiBase);
    return this.hevy;
  }

  async test() {
    const result = { garmin: { ok: false }, hevy: { ok: false } };
    try {
      await this.getGarmin().login();
      result.garmin.ok = true;
    } catch (e) {
      result.garmin.error = e.message;
    }
    try {
      result.hevy.detail = await this.getHevy().testConnection();
      result.hevy.ok = true;
    } catch (e) {
      result.hevy.error = e.message;
    }
    return result;
  }
}

module.exports = new AuthService();
