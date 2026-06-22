'use strict';

const config = require('./config');
const logger = require('./logger');
const auth = require('./auth-service');

// Drives the polling loop: every pollIntervalMs it asks Garmin for the latest
// heart rate reading and accumulates avg/min/max for the session.
//
// NOTE: The public Hevy API does not expose an endpoint for streaming live
// heart rate into an in-progress workout, so this service detects the most
// recent Hevy workout (treated as the "active" one) and tracks the HR stats
// locally, exposing them via GET /sync/status. It does NOT overwrite Hevy
// workout data.
class SyncService {
  constructor() {
    this.running = false;
    this.timer = null;
    this.reset();
  }

  reset() {
    this.startedAt = null;
    this.lastReadingAt = null;
    this.lastHeartRate = null;
    this.count = 0;
    this.sum = 0;
    this.min = null;
    this.max = null;
    this.errors = 0;
    this.lastError = null;
    this.activeWorkout = null;
  }

  get avg() {
    return this.count ? Math.round(this.sum / this.count) : null;
  }

  async start() {
    if (this.running) return this.status();
    const garmin = auth.getGarmin();
    await garmin.login(); // verify auth before we kick off the interval
    this.reset();
    this.running = true;
    this.startedAt = new Date().toISOString();
    logger.info('Sync started; polling Garmin every %dms', config.pollIntervalMs);
    this.timer = setInterval(() => this._tick().catch((e) => this._onError(e)), config.pollIntervalMs);
    // Fire one tick immediately so status reflects data right away.
    this._tick().catch((e) => this._onError(e));
    return this.status();
  }

  async _tick() {
    const garmin = auth.getGarmin();
    const reading = await garmin.getLatestHeartRate();
    if (reading && typeof reading.bpm === 'number') {
      this.lastHeartRate = reading.bpm;
      this.lastReadingAt = new Date(reading.timestamp || Date.now()).toISOString();
      this.count++;
      this.sum += reading.bpm;
      this.min = this.min === null ? reading.bpm : Math.min(this.min, reading.bpm);
      this.max = this.max === null ? reading.bpm : Math.max(this.max, reading.bpm);
      logger.debug(
        'HR %d bpm (avg %s, min %s, max %s, n=%d)',
        reading.bpm,
        this.avg,
        this.min,
        this.max,
        this.count
      );
      await this._trackActiveWorkout();
    }
  }

  async _trackActiveWorkout() {
    try {
      const hevy = auth.getHevy();
      const recent = await hevy.getRecentWorkouts(1);
      this.activeWorkout = recent && recent[0] ? { id: recent[0].id, title: recent[0].title } : null;
    } catch (e) {
      // Non-fatal: Hevy lookups should never break the HR loop.
      logger.debug('Hevy workout lookup failed: %s', e.message);
    }
  }

  _onError(e) {
    this.errors++;
    this.lastError = e.message;
    logger.error('Sync tick error: %s', e.message);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.running = false;
    logger.info('Sync stopped. Summary: avg=%s min=%s max=%s n=%d', this.avg, this.min, this.max, this.count);
    return this.status();
  }

  status() {
    return {
      running: this.running,
      startedAt: this.startedAt,
      lastReadingAt: this.lastReadingAt,
      pollIntervalMs: config.pollIntervalMs,
      heartRate: {
        current: this.lastHeartRate,
        avg: this.avg,
        min: this.min,
        max: this.max,
        samples: this.count,
      },
      activeWorkout: this.activeWorkout,
      errors: this.errors,
      lastError: this.lastError,
    };
  }
}

module.exports = new SyncService();
